'use strict';

const deezer = require('./deezer');
const { themePool, workYear, THEME_BY_ID, songKey, dedupeSongs, albumMatches } = require('./online');
const community = require('./community');
const { isBadVersion } = require('./quality');
const { randomOpening } = require('./anime');
const { frenchNames } = require('./wikidata');
const { nameVariants } = require('./names');
const { cleanTitle, cleanArtist, tokenize } = require('./matching');
const { inPeriod } = require('./periods');
const { weightedPick, weightedShuffle } = require('./popularity');
const { mapLimit } = require('./http');

const SONG_TARGETS = [{ key: 'artist', label: 'Artiste' }, { key: 'title', label: 'Titre' }];
const WORK = {
  film: { label: 'Film', prompt: 'Trouve le film' },
  series: { label: 'Série', prompt: 'Trouve la série' },
  anime: { label: 'Anime', prompt: 'Trouve l’anime' },
  disney: { label: 'Film', prompt: 'Trouve le film Disney' },
  game: { label: 'Jeu', prompt: 'Trouve le jeu vidéo' },
  custom: { label: 'Œuvre', prompt: 'Trouve l’œuvre' },
};

// Les morceaux ne sont pas filtrés par période ; une œuvre dont l'année n'est pas encore connue
// est gardée et vérifiée au moment de la jouer
function filterPeriod(pool, period) {
  if (period === 'all') return pool;
  return pool.filter((item) => item.type === 'track' || inPeriod(item.year, period) !== false
    && !(item.type === 'anime' && !item.year));
}

/*
  Construit la file de la partie à partir de plusieurs thèmes :
  chaque thème est mélangé en privilégiant les éléments populaires, puis à chaque extrait
  on tire un thème au hasard. Tous les thèmes cochés sont donc représentés à parts égales.
  `playlistId` : playlist Deezer perso ajoutée comme un thème de plus.
*/
async function buildQueue(themeIds, period = 'all', playlistId = null) {
  const jobs = themeIds.map((id) => ({
    id,
    label: id.startsWith('c:') ? ((community.get(id.slice(2)) || {}).name || 'Thème supprimé') : (THEME_BY_ID.get(id) || {}).label || id,
  }));
  if (playlistId) jobs.push({ id: 'playlist', label: 'Playlist perso' });

  const errors = [];
  const lists = (await mapLimit(jobs, 2, async (job) => {
    try {
      let pool;
      if (job.id === 'playlist') {
        pool = (await deezer.loadTracks(`playlist:${playlistId}`)).map((track) => ({ type: 'track', track }));
      } else if (job.id.startsWith('c:')) {
        const t = community.get(job.id.slice(2));
        if (!t) throw new Error('thème supprimé');
        pool = await community.pool(t, { dedupeSongs });
        community.countPlay(t.id);
      } else {
        pool = await themePool(job.id);
      }
      const usable = filterPeriod(pool, period);
      for (const item of usable) item.themeId = job.id; // pour la couleur et l'étiquette du thème
      if (!pool.length) errors.push(`${job.label} (aucun extrait trouvé)`);
      else if (!usable.length) errors.push(`${job.label} (rien pour cette période)`);
      return weightedShuffle(usable);
    } catch (err) {
      errors.push(`${job.label} (${err.message})`);
      return [];
    }
  })).filter((l) => l && l.length);

  // Entrelacement des thèmes, sans doublons : une même chanson présente dans « Rap FR » et
  // « Années 2010 », ou un même film dans « Films » et « Disney », n'est jouée qu'une fois
  const queue = [];
  const seen = new Set();
  while (lists.some((l) => l.length)) {
    const available = lists.filter((l) => l.length);
    const item = available[Math.floor(Math.random() * available.length)].shift();
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(item);
  }
  return { queue, errors };
}

function itemKey(item) {
  if (item.type === 'track') return `song:${songKey(item.track)}`;
  if (item.type === 'screen') return `work:${tokenize(item.name).join('')}`;
  if (item.type === 'anime') return `anime:${item.site}:${item.externalId}:${item.themeType}`;
  if (item.type === 'custom') return `work:${tokenize(item.name).join('')}`;
  return Math.random().toString(36);
}

function songRound(track) {
  return {
    track,
    targets: SONG_TARGETS,
    answers: { artist: [cleanArtist(track.artist)], title: [cleanTitle(track.title)] },
    prompt: 'Trouve l’artiste et le titre',
    reveal: { headline: track.fullTitle || track.title, sub: track.artist },
  };
}

async function workRound(kind, names, track, wd) {
  const base = names[0];
  const all = new Set();
  const main = new Set([base, wd.fr].filter(Boolean));
  for (const n of [wd.fr, ...names, ...wd.aliases]) {
    if (!n) continue;
    for (const v of nameVariants(n)) {
      // Les alias trop courts ("OP", "TV"…) seraient trouvés par hasard : on ne garde que les noms principaux
      if (main.has(n) || tokenize(v).join('').length >= 3) all.add(v);
    }
  }
  const title = wd.fr && wd.fr.toLowerCase() !== base.toLowerCase() ? `${wd.fr} (${base})` : base;
  const year = wd.year || null;
  const headline = year ? `${title}, ${year}` : title;
  // Autres noms acceptés, affichés à la révélation (sans répéter ceux déjà dans le titre)
  const shown = new Set([base, wd.fr].filter(Boolean).map((n) => tokenize(n).join('')));
  const accepted = [];
  for (const n of all) {
    const k = tokenize(n).join('');
    if (!k || shown.has(k) || !/[a-z]/i.test(n)) continue;
    shown.add(k);
    accepted.push(n);
    if (accepted.length >= 6) break;
  }
  return {
    track,
    targets: [{ key: 'work', label: WORK[kind].label }],
    answers: { work: [...all] },
    prompt: WORK[kind].prompt,
    reveal: { headline, sub: [track.title, track.artist].filter(Boolean).join(', '), accepted },
  };
}

// Transforme un item en manche jouable (extrait + réponses). Renvoie null si impossible.
async function resolveItem(item, usedTrackIds, period = 'all') {
  if (item.type === 'track') {
    if (usedTrackIds.has(item.track.id)) return null;
    if (item.check) {
      // Vérification de l'album (année, genre) : un intrus est écarté, on passe au morceau suivant
      const info = await deezer.albumInfo(item.track.albumId);
      const verdict = albumMatches(info, item.check);
      if (verdict === false || (verdict === null && item.check.years)) return null;
    }
    const fresh = await deezer.freshPreview(item.track.id);
    if (!fresh && !item.track.preview) return null;
    return songRound({ ...item.track, preview: fresh || item.track.preview });
  }

  if (item.type === 'screen') {
    const options = item.tracks.filter((t) => !usedTrackIds.has(t.id));
    if (!options.length) return null;
    if (period !== 'all') {
      if (!item.year) item.year = await workYear(item);
      if (inPeriod(item.year, period) !== true) return null;
    }
    const wd = { ...(await frenchNames(item.name, item.kind)) };
    if (wd.sitelinks != null) item.sitelinks = wd.sitelinks;
    if (!wd.year) wd.year = item.year || null;
    const pick = weightedPick(options, (t) => t.rank); // le morceau le plus écouté de la BO a plus de chances
    const fresh = await deezer.freshPreview(pick.id);
    return workRound(item.kind, [item.name], { ...pick, preview: fresh || pick.preview }, wd);
  }

  if (item.type === 'custom') {
    // Œuvre d'un thème de la communauté : l'extrait est cherché sur Deezer
    const hint = { Film: 'soundtrack', 'Série': 'theme', Jeu: 'soundtrack', Anime: 'opening' }[item.label] || '';
    const results = await deezer.searchTracks(item.q || `${item.name} ${hint}`.trim(), 10);
    const track = results.find((t) => !usedTrackIds.has(t.id) && !isBadVersion(t));
    if (!track) return null;
    const kind = { Film: 'film', 'Série': 'series', Jeu: 'game', Anime: 'anime' }[item.label] || 'custom';
    const wd = await frenchNames(item.name, kind);
    const round = await workRound(kind, [item.name, ...item.aliases], track, wd);
    round.targets = [{ key: 'work', label: item.label }];
    round.prompt = item.label === 'Œuvre' ? 'Trouve l’œuvre' : WORK[kind] ? WORK[kind].prompt : `Trouve : ${item.label.toLowerCase()}`;
    return round;
  }

  if (item.type === 'anime') {
    if (inPeriod(item.year, period) !== true) return null;
    const op = await randomOpening(item, item.themeType || 'OP');
    if (!op || usedTrackIds.has(op.id)) return null;
    const track = {
      id: op.id, title: op.song, fullTitle: op.song, artist: op.artist,
      preview: op.audio || op.video, previewAlt: op.video, cover: item.cover || '', link: '',
    };
    const wd = await frenchNames(item.name, 'anime');
    const round = await workRound('anime', item.names, track, { ...wd, year: item.year || wd.year });
    if (item.themeType === 'ED') round.prompt = 'Trouve l’anime (ending)';
    return round;
  }
  return null;
}

module.exports = { buildQueue, resolveItem };
