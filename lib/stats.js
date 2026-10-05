'use strict';

/*
  Statistiques de partie : bilan personnel de chaque joueur et difficulté adaptative.
*/

function newStats() {
  return { played: 0, found: 0, firsts: 0, times: [], fastest: null, streak: 0, maxStreak: 0, themes: {} };
}

// Début de manche : le joueur est présent pour cet extrait
function onRoundStart(player, theme) {
  const s = player.stats;
  s.played++;
  player.foundThisRound = false;
  if (theme) {
    s.themes[theme.id] = s.themes[theme.id] || { label: theme.label, played: 0, found: 0 };
    s.themes[theme.id].played++;
  }
}

// Une bonne réponse validée (ms = temps de réaction compensé, rank = 0 si premier)
function onFind(player, { ms, rank, themeId, label }) {
  const s = player.stats;
  if (rank === 0) s.firsts++;
  if (player.foundThisRound) return; // l'artiste puis le titre : une seule trouvaille par extrait
  player.foundThisRound = true;
  s.found++;
  s.times.push(ms);
  if (!s.fastest || ms < s.fastest.ms) s.fastest = { ms, label };
  if (themeId && s.themes[themeId]) s.themes[themeId].found++;
}

function onRoundEnd(player) {
  const s = player.stats;
  s.streak = player.foundThisRound ? s.streak + 1 : 0;
  s.maxStreak = Math.max(s.maxStreak, s.streak);
}

function recap(player) {
  const s = player.stats;
  const themes = Object.values(s.themes).filter((t) => t.played >= 2).map((t) => ({ ...t, rate: t.found / t.played }));
  themes.sort((a, b) => b.rate - a.rate || b.played - a.played);
  return {
    played: s.played,
    found: s.found,
    rate: s.played ? s.found / s.played : 0,
    avgMs: s.times.length ? Math.round(s.times.reduce((a, b) => a + b, 0) / s.times.length) : null,
    fastest: s.fastest,
    firsts: s.firsts,
    maxStreak: s.maxStreak,
    bestTheme: themes.length >= 2 ? themes[0] : null,
    worstTheme: themes.length >= 2 ? themes[themes.length - 1] : null,
  };
}

/*
  Difficulté adaptative : niveau de -2 (classiques) à +2 (pointu), ajusté selon la part de joueurs
  qui trouvent sur les 3 derniers extraits. Le niveau oriente le choix des extraits suivants
  vers des œuvres plus ou moins populaires.
*/
const LEVEL_RANGES = {
  '-2': [0.75, 1.01],
  '-1': [0.55, 1.01],
  1: [0.3, 0.8],
  2: [0, 0.5],
};

function updateLevel(room) {
  const players = [...room.players.values()];
  if (!players.length) return;
  const share = players.filter((p) => p.foundThisRound).length / players.length;
  room.recentSuccess = [...(room.recentSuccess || []), share].slice(-3);
  if (room.recentSuccess.length < 2) return;
  const avg = room.recentSuccess.reduce((a, b) => a + b, 0) / room.recentSuccess.length;
  const before = room.level || 0;
  if (avg >= 0.66) room.level = Math.min(2, before + 1);
  else if (avg <= 0.25) room.level = Math.max(-2, before - 1);
  if (room.level !== before) room.recentSuccess = []; // on laisse le temps au nouveau niveau
}

// Prend jusqu'à `n` éléments en tête de file, en privilégiant ceux qui correspondent au niveau
function pickBatch(queue, level, n = 4) {
  const range = LEVEL_RANGES[level];
  if (!range) return queue.splice(0, n);
  const windowSize = Math.min(40, queue.length);
  const picked = [];
  for (let i = 0; i < windowSize && picked.length < n; i++) {
    const pop = queue[i].pop ?? 0.35;
    if (pop >= range[0] && pop < range[1]) picked.push(i);
  }
  for (let i = 0; i < windowSize && picked.length < n; i++) if (!picked.includes(i)) picked.push(i);
  picked.sort((a, b) => b - a); // on retire de la fin vers le début
  const batch = picked.map((i) => queue.splice(i, 1)[0]);
  return batch.reverse();
}

module.exports = { newStats, onRoundStart, onFind, onRoundEnd, recap, updateLevel, pickBatch };
