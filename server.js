'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { checkGuess } = require('./lib/matching');
const deezer = require('./lib/deezer');
const { buildQueue, resolveItem } = require('./lib/rounds');
const { THEMES, THEME_BY_ID } = require('./lib/online');
const { PERIODS } = require('./lib/periods');
const { setBrowserRelay } = require('./lib/http');
const suggest = require('./lib/suggest');
const stats = require('./lib/stats');
const community = require('./lib/community');
const salles = require('./lib/salles');
const musiccatalog = require('./lib/musiccatalog');

const PORT = Number(process.env.PORT) || 3000;
const START_DELAY_MS = 2500;  // temps laissé aux clients pour précharger l'extrait
const REVEAL_MS = 7000;       // durée d'affichage de la réponse
const GRACE_MS = 400;         // tolérance réseau en fin de manche
const POINTS_DOUBLE = [3, 2, 1]; // manche artiste + titre : 1er, 2e, suivants, pour chacun
const POINTS_SINGLE = [6, 4, 2]; // manche à une seule réponse (film, série, anime)
const MAX_PLAYERS = 30;
const GUESS_COOLDOWN_MS = 150;
const RESUME_DELAY_MS = 1500; // compte à rebours à la reprise après une pause

// Compensation de latence : une bonne réponse est datée au moment où le joueur l'a vraiment tapée,
// en retirant son délai réseau (moitié du ping) et le retard de démarrage de son extrait.
// Les bonnes réponses arrivées dans une même fenêtre de 300 ms sont classées sur ce temps corrigé.
const COMP_WINDOW_MS = 300;
const MAX_NET_COMP_MS = 400;
const MAX_AUDIO_COMP_MS = 1500;
const DIFFICULTIES = ['normal', 'adaptive'];
// Mode Twitch : les spectateurs entendent le stream avec quelques secondes de retard,
// leurs réponses restent donc acceptées un court instant après la fin de l'extrait
const TWITCH_GRACE_MS = 3000;
const TWITCH_COOLDOWN_MS = 1000;

const THEME_LIST = THEMES.map(({ id, label, group }) => ({ id, label, group }));
const DEFAULT_THEMES = ['rapfr', 'films', 'series', 'anime'];
const GOALS = [10, 20, 30, 50];
const DURATIONS = [15, 20, 25, 30];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// Salles permanentes : /salle/3bci affiche le jeu, qui rejoint la salle automatiquement
// État du catalogue musical (nombre de morceaux par thème, date de mise à jour)
app.get('/catalogue.json', (req, res) => res.json(musiccatalog.status()));
app.get('/salle/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 }); // réponses relayées par les navigateurs

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------- Utilitaires ----------

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return n || 'Joueur';
}

function themeLabel(id) {
  if (id.startsWith('c:')) return (community.get(id.slice(2)) || {}).name || 'thème supprimé';
  return (THEME_BY_ID.get(id) || {}).label || id;
}
const validTheme = (id) => THEME_BY_ID.has(id) || (typeof id === 'string' && id.startsWith('c:') && !!community.get(id.slice(2)));

function themesLabel(settings) {
  const labels = settings.themes.map(themeLabel);
  if (settings.playlist) labels.push('playlist perso');
  return labels.join(', ');
}

function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    settings: { ...room.settings, themesLabel: themesLabel(room.settings) },
    communityThemes: room.settings.themes.filter((id) => id.startsWith('c:')).map((id) => ({ id, label: themeLabel(id) })),
    salle: room.slug ? salles.publicInfo(room.slug) : null,
    twitch: room.settings.twitch ? twitchBoard(room) : null,
    roundNumber: room.roundNumber,
    paused: !!room.paused,
    skip: ['round', 'reveal'].includes(room.state)
      ? { voters: [...(room.skipVotes || [])], needed: room.players.size }
      : null,
    level: room.level || 0,
    targetCount: room.round ? room.round.targets.length : 0,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, score: p.score, foundCount: p.found.size,
    })),
  };
}

function broadcast(room) {
  io.to(room.code).emit('room:state', publicState(room));
}

function notice(target, text, type = 'info') {
  target.emit('notice', { text, type });
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function ranking(room) {
  return [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function roundPayload(room) {
  const r = room.round;
  return {
    number: room.roundNumber, preview: r.track.preview, previewAlt: r.track.previewAlt || null,
    startAt: r.startAt, endsAt: r.endsAt, offset: r.offset || 0, durationMs: r.durationMs,
    targets: r.targets, prompt: r.prompt, theme: themeInfo(r.themeId),
  };
}

function themeInfo(themeId) {
  const t = THEME_BY_ID.get(themeId);
  if (t) return { id: t.id, label: t.label, family: t.family };
  if (themeId && themeId.startsWith('c:')) return { id: themeId, label: themeLabel(themeId), family: 'community' };
  return themeId === 'playlist' ? { id: 'playlist', label: 'Playlist perso', family: 'music' } : null;
}

function revealPayload(room) {
  const r = room.round;
  return { ...r.reveal, cover: r.track.cover, link: r.track.link };
}

// ---------- Vote pour passer ----------
// Quand tous les joueurs ont voté, l'extrait est révélé tout de suite (ou on passe au suivant si
// la réponse est déjà affichée)
function checkSkipVotes(room) {
  if (!room.skipVotes || !room.players.size || room.paused) return;
  for (const id of room.skipVotes) if (!room.players.has(id)) room.skipVotes.delete(id);
  if (room.skipVotes.size < room.players.size) return;
  if (room.state === 'round' && room.round) endRound(room, room.gameToken);
  else if (room.state === 'reveal') afterReveal(room, room.gameToken);
}

// ---------- Mode Twitch ----------
function twitchBoard(room) {
  return [...(room.twitchScores || new Map()).values()].sort((a, b) => b.score - a.score).slice(0, 10);
}

function twitchGuess(room, user, text) {
  const r = room.round;
  if (!r || room.paused) return;
  const now = Date.now();
  const open = (room.state === 'round' && now >= r.startAt) || (room.state === 'reveal' && now <= r.endsAt + TWITCH_GRACE_MS);
  if (!open) return;
  const login = String(user || '').toLowerCase().slice(0, 25);
  if (!login) return;
  const viewer = room.twitchScores.get(login) || { name: login, score: 0, last: 0 };
  if (now - viewer.last < TWITCH_COOLDOWN_MS) return;
  viewer.last = now;
  room.twitchScores.set(login, viewer);

  const found = room.twitchFound.get(login) || new Set();
  const res = checkGuess(String(text || '').slice(0, 100), r.answers);
  const points = r.targets.length === 1 ? POINTS_SINGLE : POINTS_DOUBLE;
  let gained = false;
  for (const { key, label } of r.targets) {
    if (!res[key] || found.has(key)) continue;
    found.add(key);
    const rank = room.twitchRanks[key]++;
    const pts = points[Math.min(rank, points.length - 1)];
    viewer.score += pts;
    gained = true;
    io.to(room.code).emit('twitch:feed', { name: viewer.name, label, pts, rank });
  }
  room.twitchFound.set(login, found);
  if (gained) broadcast(room);
}

function makeRoom(hostId, settings) {
  return {
    code: makeCode(),
    hostId,
    slug: null,
    players: new Map(),
    settings: {
      themes: [...DEFAULT_THEMES], playlist: null, goal: 30, duration: 25, period: 'all', difficulty: 'adaptive', twitch: null,
      suggestions: true,
      ...(settings || {}),
    },
    usedTrackIds: new Set(),
    banned: new Set(),
    paused: null,
    level: 0,
    state: 'lobby',
    queue: [],
    round: null,
    roundNumber: 0,
    timer: null,
    gameToken: 0,
    twitchScores: new Map(),
    twitchFound: new Map(),
  };
}

// ---------- Déroulement d'une partie ----------

async function startGame(room) {
  clearTimer(room);
  const token = ++room.gameToken;
  room.state = 'loading';
  room.round = null;
  room.roundNumber = 0;
  for (const p of room.players.values()) { p.score = 0; p.found.clear(); p.stats = stats.newStats(); }
  room.paused = null;
  room.level = 0;
  room.recentSuccess = [];
  room.twitchScores = new Map();
  broadcast(room);

  const { queue, errors } = await buildQueue(room.settings.themes, room.settings.period, room.settings.playlist);
  if (room.gameToken !== token || !rooms.has(room.code)) return;
  if (queue.length < 3) {
    room.state = 'lobby';
    const why = errors.length ? ` Problèmes : ${errors.join(', ')}.` : '';
    const msg = room.settings.period !== 'all'
      ? `Trop peu d’extraits pour cette période avec ces thèmes. Élargis la période ou ajoute des thèmes.${why}`
      : `Impossible de charger assez d’extraits.${why}`;
    notice(io.to(room.code), msg, 'error');
    broadcast(room);
    return;
  }
  if (errors.length) notice(io.to(room.code), `Thèmes ignorés : ${errors.join(', ')}. La partie continue avec les autres.`);
  room.queue = queue; // déjà mélangée : thèmes à parts égales, populaires en priorité
  room.allItems = [...queue];
  room.suggestIndex = suggest.buildIndex(room.allItems); // toutes les réponses possibles, pour l'autocomplétion
  room.preparing = null;
  room.usedTrackIds = new Set();
  nextRound(room, token);
}

const STALE = Symbol('partie terminée entre-temps');
const isStale = (room, token) => room.gameToken !== token || !rooms.has(room.code);

// Cherche un extrait jouable : items testés par lots de 4 en parallèle, 20 s maximum
// (extrait disponible, année dans la période choisie, etc.). Renvoie null si rien ne convient.
async function findPlayable(room, token) {
  const deadline = Date.now() + 20000;
  while (room.queue.length && Date.now() < deadline) {
    const level = room.settings.difficulty === 'adaptive' ? room.level || 0 : 0;
    const batch = stats.pickBatch(room.queue, level, 4);
    const results = await Promise.all(batch.map((item) =>
      resolveItem(item, room.usedTrackIds, room.settings.period)
        .catch((err) => { console.warn('Item ignoré :', err.message); return null; })));
    if (isStale(room, token)) return STALE;
    const idx = results.findIndex(Boolean);
    if (idx >= 0) {
      // Les autres items valides du lot resservent plus tard
      batch.forEach((item, i) => { if (i !== idx && results[i]) room.queue.push(item); });
      room.usedTrackIds.add(results[idx].track.id);
      results[idx].themeId = batch[idx].themeId;
      return results[idx];
    }
  }
  return null;
}

// Prépare la manche suivante en arrière-plan pendant que la manche en cours se joue,
// et demande aux navigateurs de télécharger l'extrait à l'avance
function prepareNext(room, token) {
  if (!room.preparing) {
    room.preparing = findPlayable(room, token).then((res) => {
      if (res && res !== STALE && !isStale(room, token)) {
        io.to(room.code).emit('round:preload', { preview: res.track.preview, previewAlt: res.track.previewAlt || null });
      }
      return res;
    });
  }
  return room.preparing;
}

async function nextRound(room, token) {
  if (isStale(room, token)) return;

  const resolved = await prepareNext(room, token);
  room.preparing = null;
  if (resolved === STALE || isStale(room, token)) return;
  if (!resolved) {
    if (room.roundNumber === 0) {
      // Aucune manche jouée : on revient au salon avec une explication, sans podium
      room.gameToken++;
      room.state = 'lobby';
      room.round = null;
      notice(io.to(room.code), room.settings.period !== 'all'
        ? 'Aucun extrait trouvé pour cette période. Élargis la période, ou réessaie dans une minute (les années des œuvres sont encore en cours de récupération).'
        : 'Aucun extrait jouable trouvé pour cette catégorie. Réessaie dans un instant ou choisis-en une autre.', 'error');
      broadcast(room);
      return;
    }
    return endGame(room, 'Plus d’extraits disponibles avec ces réglages.');
  }
  const theme = themeInfo(resolved.themeId);
  for (const p of room.players.values()) {
    p.found.clear();
    p.audioLag = 0;
    stats.onRoundStart(p, theme);
  }
  const startAt = Date.now() + START_DELAY_MS;
  room.roundNumber += 1;
  room.paused = null;
  room.round = {
    ...resolved,
    startAt,
    endsAt: startAt + room.settings.duration * 1000,
    durationMs: room.settings.duration * 1000,
    offset: 0,
    finders: Object.fromEntries(resolved.targets.map((t) => [t.key, []])),
    pending: [],
    pendingTimer: null,
  };
  room.state = 'round';
  room.skipVotes = new Set();
  room.twitchFound = new Map();
  room.twitchRanks = Object.fromEntries(resolved.targets.map((t) => [t.key, 0]));
  // L'index est recalculé à chaque manche : les titres français récupérés entre-temps y entrent
  if (room.allItems) room.suggestIndex = suggest.buildIndex(room.allItems);
  io.to(room.code).emit('round:start', roundPayload(room));
  broadcast(room);

  clearTimer(room);
  room.timer = setTimeout(() => endRound(room, token), room.round.endsAt - Date.now() + GRACE_MS);
  prepareNext(room, token); // la suivante se cherche pendant que celle-ci se joue
}

// Valide les bonnes réponses en attente, classées sur leur temps corrigé (compensation de latence)
function finalizePending(room) {
  const r = room.round;
  if (!r || !r.pending.length) return;
  clearTimeout(r.pendingTimer);
  r.pendingTimer = null;
  const batch = r.pending.splice(0).sort((a, b) => a.eff - b.eff);
  const points = r.targets.length === 1 ? POINTS_SINGLE : POINTS_DOUBLE;
  for (const g of batch) {
    const p = room.players.get(g.pid);
    if (!p) continue;
    const rank = r.finders[g.key].push(p.id) - 1;
    const pts = points[Math.min(rank, points.length - 1)];
    p.score += pts;
    const ms = Math.max(0, Math.round(g.eff - r.startAt + (r.offset || 0) * 1000));
    stats.onFind(p, { ms, rank, themeId: r.themeId, label: r.reveal.headline });
    io.to(room.code).emit('feed', { name: p.name, label: g.label, pts, rank, ms });
  }
  broadcast(room);
  if (room.state === 'round' && everyoneDone(room)) {
    // Tout le monde a tout trouvé : on abrège la manche
    const token = room.gameToken;
    clearTimer(room);
    r.endsAt = Date.now();
    room.timer = setTimeout(() => endRound(room, token), 700);
  }
}

function endRound(room, token) {
  if (room.gameToken !== token || room.state !== 'round') return;
  clearTimer(room);
  finalizePending(room);
  for (const p of room.players.values()) stats.onRoundEnd(p);
  if (room.settings.difficulty === 'adaptive') stats.updateLevel(room);
  room.skipVotes = new Set();
  room.state = 'reveal';
  io.to(room.code).emit('round:reveal', revealPayload(room));
  broadcast(room);

  room.timer = setTimeout(() => afterReveal(room, token), REVEAL_MS);
}

function afterReveal(room, token) {
  if (room.gameToken !== token || room.state !== 'reveal') return;
  clearTimer(room);
  if (ranking(room).some((p) => p.score >= room.settings.goal)) endGame(room);
  else nextRound(room, token);
}

function endGame(room, reason) {
  clearTimer(room);
  room.preparing = null;
  room.gameToken++;
  room.state = 'ended';
  room.round = null;
  room.paused = null;
  const final = ranking(room);
  io.to(room.code).emit('game:end', {
    ranking: final,
    reason: reason || null,
    twitch: room.settings.twitch ? twitchBoard(room).slice(0, 5) : null,
  });
  if (room.slug && room.roundNumber > 0) salles.recordGame(room.slug, final, room.roundNumber);
  // Bilan personnel envoyé à chaque joueur
  for (const p of room.players.values()) {
    const sock = io.sockets.sockets.get(p.id);
    if (sock && p.stats && p.stats.played) sock.emit('game:recap', stats.recap(p));
  }
  broadcast(room);
}

function everyoneDone(room) {
  const players = [...room.players.values()];
  const n = room.round.targets.length;
  return players.length > 0 && players.every((p) => p.found.size >= n);
}

// ---------- Relais navigateur ----------
// Quand une API bloque le serveur, on demande au navigateur d'un hôte connecté de faire la requête.
// On essaie les hôtes un par un (au plus 3) jusqu'à ce que l'un d'eux réussisse.
setBrowserRelay(async (url, { method = 'GET', body, headers = {} } = {}) => {
  const hosts = [...rooms.values()].map((r) => io.sockets.sockets.get(r.hostId)).filter(Boolean).slice(0, 3);
  if (!hosts.length) throw new Error('aucun hôte connecté pour relayer');
  let lastError = 'échec';
  for (const sock of hosts) {
    try {
      const res = await sock.timeout(15000).emitWithAck('relay:fetch', { url, method, body, accept: headers.Accept });
      if (res && res.ok) return res.data;
      lastError = (res && res.error) || 'réponse vide';
    } catch (err) {
      lastError = 'pas de réponse du navigateur';
    }
  }
  throw new Error(lastError);
});

// ---------- Connexions ----------

io.on('connection', (socket) => {
  let room = null;

  socket.emit('hello', { themes: THEME_LIST, goals: GOALS, durations: DURATIONS, periods: PERIODS });

  socket.on('time:sync', (cb) => typeof cb === 'function' && cb(Date.now()));

  function enter(targetRoom, name, key) {
    room = targetRoom;
    if (key) socket.data.key = String(key).slice(0, 64);
    socket.join(room.code);
    room.players.set(socket.id, {
      id: socket.id, name: cleanName(name), score: 0, found: new Set(), lastGuess: 0,
      key: String(key || '').slice(0, 64), stats: stats.newStats(), audioLag: 0,
    });
    broadcast(room);
    // Arrivée en cours de manche : on lui envoie l'extrait en cours
    if (room.state === 'round') {
      stats.onRoundStart(room.players.get(socket.id), themeInfo(room.round.themeId));
      socket.emit('round:start', roundPayload(room));
      if (room.paused) socket.emit('game:paused');
    }
    if (room.state === 'reveal') socket.emit('round:reveal', revealPayload(room));
  }

  socket.on('room:create', ({ name, key } = {}, cb) => {
    if (room || typeof cb !== 'function') return;
    const newRoom = makeRoom(socket.id);
    rooms.set(newRoom.code, newRoom);
    enter(newRoom, name, key);
    cb({ ok: true, code: newRoom.code });
  });

  // Entrer dans une salle permanente (/salle/slug) : on rejoint son salon actif, ou on le rouvre
  socket.on('salle:open', ({ slug, name, key } = {}, cb) => {
    if (room || typeof cb !== 'function') return;
    const salle = salles.get(slug);
    if (!salle) return cb({ ok: false, error: 'Cette salle n’existe pas. Crée un salon puis rends-le permanent.' });
    let target = [...rooms.values()].find((r) => r.slug === salle.slug);
    if (!target) {
      target = makeRoom(socket.id, salle.settings);
      target.slug = salle.slug;
      rooms.set(target.code, target);
    }
    if (key && target.banned.has(String(key))) return cb({ ok: false, error: 'L’hôte t’a exclu de cette salle.' });
    if (target.players.size >= MAX_PLAYERS) return cb({ ok: false, error: 'Cette salle est complète.' });
    enter(target, name, key);
    if (key && key === salle.ownerKey) { target.hostId = socket.id; broadcast(target); } // la propriétaire redevient hôte
    cb({ ok: true, code: target.code, slug: salle.slug });
  });

  // Rendre le salon actuel permanent
  socket.on('salle:create', ({ slug, title, key } = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!room || room.hostId !== socket.id) return reply({ ok: false, error: 'Seul l’hôte peut faire ça.' });
    if (room.slug) return reply({ ok: false, error: 'Ce salon est déjà permanent.' });
    const res = salles.create({ slug, title, ownerKey: String(key || ''), settings: room.settings });
    if (!res.ok) return reply(res);
    room.slug = res.slug;
    broadcast(room);
    reply(res);
  });

  // ---------- Thèmes de la communauté ----------
  socket.on('community:list', ({ query } = {}, cb) => typeof cb === 'function' && cb(community.list(socket.data.key, query)));
  socket.on('community:create', (input = {}, cb) => {
    if (typeof cb !== 'function') return;
    const now = Date.now();
    if (now - (socket.data.lastCreate || 0) < 10000) return cb({ ok: false, error: 'Attends quelques secondes avant de créer un autre thème.' });
    socket.data.lastCreate = now;
    cb(community.create({ ...input, key: socket.data.key }));
  });
  socket.on('community:like', ({ id } = {}, cb) => {
    const ok = community.toggleLike(id, socket.data.key);
    if (typeof cb === 'function') cb({ ok });
  });
  socket.on('community:delete', ({ id } = {}, cb) => {
    const ok = community.remove(id, socket.data.key);
    if (typeof cb === 'function') cb({ ok, error: ok ? null : 'Seul le créateur peut supprimer ce thème.' });
  });
  socket.on('identify', ({ key } = {}) => { socket.data.key = String(key || '').slice(0, 64); });

  socket.on('room:join', ({ code, name, key } = {}, cb) => {
    if (room || typeof cb !== 'function') return;
    const target = rooms.get(String(code || '').trim().toUpperCase());
    if (!target) return cb({ ok: false, error: 'Aucun salon avec ce code. Vérifie les 4 lettres.' });
    if (target.players.size >= MAX_PLAYERS) return cb({ ok: false, error: 'Ce salon est complet.' });
    if (key && target.banned.has(String(key))) return cb({ ok: false, error: 'L’hôte t’a exclu de ce salon.' });
    enter(target, name, key);
    cb({ ok: true, code: target.code });
  });

  socket.on('room:settings', (input = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!room || room.hostId !== socket.id) return reply({ ok: false, error: 'Seul l’hôte peut modifier les réglages.' });
    if (!['lobby', 'ended'].includes(room.state)) return reply({ ok: false, error: 'Réglages verrouillés pendant la partie.' });

    const s = room.settings;
    let playlist = s.playlist;
    if (typeof input.playlist === 'string') {
      if (!input.playlist.trim()) playlist = null;
      else {
        playlist = deezer.parsePlaylistId(input.playlist);
        if (!playlist) return reply({ ok: false, error: 'Lien de playlist non reconnu. Colle un lien deezer.com/…/playlist/123456 ou juste le numéro.' });
      }
    }
    let themes = s.themes;
    if (Array.isArray(input.themes)) themes = [...new Set(input.themes.filter(validTheme))].slice(0, 30);
    if (!themes.length && !playlist) return reply({ ok: false, error: 'Choisis au moins un thème.' });
    s.themes = themes;
    s.playlist = playlist;
    if (GOALS.includes(Number(input.goal))) s.goal = Number(input.goal);
    if (DURATIONS.includes(Number(input.duration))) s.duration = Number(input.duration);
    if (PERIODS.some((p) => p.id === input.period)) s.period = input.period;
    if (DIFFICULTIES.includes(input.difficulty)) s.difficulty = input.difficulty;
    if (typeof input.suggestions === 'boolean') s.suggestions = input.suggestions;
    if (typeof input.twitch === 'string') {
      const chan = input.twitch.trim().toLowerCase().replace(/^.*twitch\.tv\//, '').replace(/[^a-z0-9_]/g, '').slice(0, 25);
      s.twitch = chan || null;
    }
    if (room.slug) salles.saveSettings(room.slug, s);
    broadcast(room);
    reply({ ok: true });
  });

  socket.on('game:start', () => {
    if (!room || room.hostId !== socket.id) return;
    if (!['lobby', 'ended'].includes(room.state)) return;
    startGame(room);
  });

  socket.on('game:stop', () => {
    if (!room || room.hostId !== socket.id) return;
    clearTimer(room);
    room.gameToken++;
    room.preparing = null;
    room.state = 'lobby';
    room.round = null;
    io.to(room.code).emit('game:stopped');
    broadcast(room);
  });

  // Autocomplétion : propositions pour le texte en cours de frappe
  socket.on('suggest', (raw, cb) => {
    if (typeof cb !== 'function') return;
    if (!room || !room.suggestIndex || !['round', 'reveal'].includes(room.state)) return cb([]);
    if (room.settings.suggestions === false) return cb([]); // propositions désactivées par l'hôte
    const now = Date.now();
    if (now - (socket.data.lastSuggest || 0) < 60) return cb(null); // trop rapide : ignoré
    socket.data.lastSuggest = now;
    cb(suggest.search(room.suggestIndex, String(raw || '').slice(0, 60), suggest.kindsForRound(room.round)));
  });

  socket.on('guess', (raw) => {
    if (!room || room.state !== 'round' || room.paused) return;
    const r = room.round;
    const now = Date.now();
    if (now < r.startAt || now > r.endsAt + GRACE_MS) return;
    const p = room.players.get(socket.id);
    if (!p || now - p.lastGuess < GUESS_COOLDOWN_MS) return;
    p.lastGuess = now;

    const text = String(raw || '').slice(0, 100);
    const res = checkGuess(text, r.answers);
    // Temps corrigé : moins le délai réseau et le retard de démarrage de l'extrait chez ce joueur
    const eff = now - Math.min((socket.data.rtt || 0) / 2, MAX_NET_COMP_MS) - Math.min(p.audioLag || 0, MAX_AUDIO_COMP_MS);
    const gained = [];
    for (const { key, label } of r.targets) {
      if (res[key] && !p.found.has(key)) {
        p.found.add(key);
        r.pending.push({ pid: p.id, key, label, eff });
        gained.push({ key, label });
      }
    }
    socket.emit('guess:result', { gained, found: [...p.found] });
    // Les points sont attribués après une courte fenêtre, une fois les réponses quasi simultanées départagées
    if (gained.length && !r.pendingTimer) {
      r.pendingTimer = setTimeout(() => { if (room && room.round === r) finalizePending(room); }, COMP_WINDOW_MS);
    }
  });

  // Retard de démarrage de l'extrait chez ce joueur (chargement lent, etc.), signalé par son navigateur
  socket.on('round:lag', ({ number, lag } = {}) => {
    if (!room || !room.round || number !== room.roundNumber) return;
    const p = room.players.get(socket.id);
    if (p) p.audioLag = Math.max(0, Math.min(Number(lag) || 0, MAX_AUDIO_COMP_MS));
  });

  // Messages du chat Twitch, relayés par le navigateur de l'hôte (connecté au chat en lecture seule)
  socket.on('twitch:msg', ({ user, text } = {}) => {
    if (!room || room.hostId !== socket.id || !room.settings.twitch) return;
    twitchGuess(room, user, text);
  });

  socket.on('vote:skip', () => {
    if (!room || room.paused || !['round', 'reveal'].includes(room.state)) return;
    room.skipVotes = room.skipVotes || new Set();
    if (room.skipVotes.has(socket.id)) room.skipVotes.delete(socket.id); // second clic : on retire son vote
    else room.skipVotes.add(socket.id);
    broadcast(room);
    checkSkipVotes(room);
  });

  // ---------- Contrôles de l'hôte ----------
  const isHost = () => room && room.hostId === socket.id;

  socket.on('host:pause', () => {
    if (!isHost() || room.paused || !['round', 'reveal'].includes(room.state)) return;
    clearTimer(room);
    if (room.state === 'round') {
      finalizePending(room);
      const r = room.round;
      const now = Date.now();
      const elapsed = Math.max(0, now - r.startAt) / 1000;
      room.paused = { phase: 'round', remaining: Math.max(1000, r.endsAt - now), offset: (r.offset || 0) + elapsed };
    } else {
      room.paused = { phase: 'reveal' };
    }
    io.to(room.code).emit('game:paused');
    broadcast(room);
  });

  socket.on('host:resume', () => {
    if (!isHost() || !room.paused) return;
    const paused = room.paused;
    room.paused = null;
    const token = room.gameToken;
    if (paused.phase === 'round') {
      const r = room.round;
      r.startAt = Date.now() + RESUME_DELAY_MS;
      r.endsAt = r.startAt + paused.remaining;
      r.offset = paused.offset;
      io.to(room.code).emit('round:resume', { startAt: r.startAt, endsAt: r.endsAt, offset: r.offset });
      room.timer = setTimeout(() => endRound(room, token), r.endsAt - Date.now() + GRACE_MS);
    } else {
      io.to(room.code).emit('round:resume', null);
      room.timer = setTimeout(() => afterReveal(room, token), RESUME_DELAY_MS);
    }
    broadcast(room);
  });

  socket.on('host:skip', () => {
    if (!isHost()) return;
    room.paused = null;
    if (room.state === 'round' && room.round) endRound(room, room.gameToken);
    else if (room.state === 'reveal') afterReveal(room, room.gameToken);
  });

  socket.on('host:kick', ({ id } = {}) => {
    if (!isHost() || id === socket.id || !room.players.has(id)) return;
    const target = io.sockets.sockets.get(id);
    const victim = room.players.get(id);
    if (victim.key) room.banned.add(victim.key);
    notice(io.to(room.code), `${victim.name} a été exclu par l’hôte.`);
    if (target) {
      target.emit('kicked');
      if (typeof target.data.leave === 'function') target.data.leave();
    }
  });

  function leave() {
    if (!room) return;
    const current = room;
    room = null;
    socket.leave(current.code);
    current.players.delete(socket.id);
    if (current.players.size === 0) {
      clearTimer(current);
      current.gameToken++;
      rooms.delete(current.code);
      return;
    }
    if (current.hostId === socket.id) current.hostId = current.players.keys().next().value;
    broadcast(current);
    checkSkipVotes(current); // le joueur parti ne bloque plus le vote
  }

  socket.data.leave = leave;
  socket.on('room:leave', leave);

  // Mesure régulière du ping de ce joueur (médiane des 5 dernières mesures)
  const rtts = [];
  const pingTimer = setInterval(() => {
    const t0 = Date.now();
    socket.timeout(3000).emit('lat', (err) => {
      if (err) return; // pas de réponse : mesure ignorée
      rtts.push(Date.now() - t0);
      if (rtts.length > 5) rtts.shift();
      socket.data.rtt = [...rtts].sort((a, b) => a - b)[Math.floor(rtts.length / 2)];
    });
  }, 5000);
  socket.on('disconnect', () => clearInterval(pingTimer));
  socket.on('disconnect', leave);
});

server.listen(PORT, () => {
  const { version } = require('./package.json');
  console.log(`Blind test v${version} prêt sur http://localhost:${PORT} (limiteur Deezer actif)`);
  // Catalogue musical (Last.fm + MusicBrainz + Deezer) : construit en arrière-plan, vérifié chaque jour,
  // chaque thème étant remis à jour une fois par semaine
  if (process.env.NO_WARMUP !== '1') {
    musiccatalog.startBackgroundJob(THEMES);
    setInterval(() => musiccatalog.startBackgroundJob(THEMES), 24 * 3600 * 1000);
  }
  // Préchargement des catégories en arrière-plan : la première partie démarre ainsi plus vite
  if (process.env.NO_WARMUP !== '1') {
    // (les anime échoueront si leurs API bloquent le serveur : ils se chargeront à la première partie)
    buildQueue(THEMES.map((t) => t.id))
      .then(({ queue, errors }) => console.log(`Thèmes préchargés : ${queue.length} extraits${errors.length ? ` (ignorés : ${errors.join(', ')})` : ''}`))
      .catch((err) => console.warn('Préchargement impossible :', err.message));
  }
});
