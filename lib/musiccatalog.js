'use strict';

/*
  Catalogue des thèmes musicaux, constitué en arrière-plan et enregistré dans data/music-catalog.json :
    1. Last.fm  : les morceaux les plus associés aux étiquettes du thème (« hard rock », « 80s »…)
                  + le nombre d'auditeurs de chaque morceau (popularité réelle)
    2. MusicBrainz (thèmes de décennies seulement) : année de première sortie exacte + code ISRC
    3. Deezer   : l'enregistrement exact (par ISRC) ou, à défaut, la meilleure correspondance artiste + titre
  Chaque morceau résolu est gardé en cache (même entre redémarrages), et chaque thème est
  remis à jour une fois par semaine. Pendant les parties, le jeu pioche directement dans ce catalogue.
*/

const fs = require('fs');
const path = require('path');
const lastfm = require('./lastfm');
const musicbrainz = require('./musicbrainz');
const deezer = require('./deezer');
const { tokenize } = require('./matching');
const { isBadVersion } = require('./quality');

const FILE = process.env.MUSIC_CATALOG_FILE || path.join(__dirname, '..', 'data', 'music-catalog.json');
const MAX_TRACKS_PER_THEME = 300;
const MIN_TRACKS = 40;              // en dessous, le thème n'est pas considéré comme prêt
const REFRESH_MS = 7 * 24 * 3600 * 1000;
const RETRY_FAILED_MS = 30 * 24 * 3600 * 1000;

let data = { themes: {}, songs: {} };
try {
  if (fs.existsSync(FILE)) data = { themes: {}, songs: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch (err) {
  console.error('Catalogue musical illisible, il sera reconstruit :', err.message);
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(data));
      fs.renameSync(`${FILE}.tmp`, FILE);
    } catch (err) {
      console.error('Sauvegarde du catalogue impossible :', err.message);
    }
  }, 2000);
}

const songKey = (artist, title) => `${tokenize(artist).join('')}|${tokenize(title).join('')}`;

// Meilleur morceau Deezer pour un artiste + titre : même artiste, même titre de préférence, bonne version
async function findOnDeezer({ artist, title, isrc }) {
  if (isrc) {
    const t = await deezer.trackByIsrc(isrc, true);
    if (t && !isBadVersion(t)) return t;
  }
  const clean = (s) => String(s).replace(/"/g, '');
  let results = [];
  try {
    results = await deezer.searchTracks(`artist:"${clean(artist)}" track:"${clean(title)}"`, 15, true);
    if (!results.length) results = await deezer.searchTracks(`${clean(artist)} ${clean(title)}`, 15, true);
  } catch {
    return null;
  }
  const a = tokenize(artist).join('');
  const ti = tokenize(title).join('');
  const sameArtist = results.filter((t) => tokenize(t.artist).join('') === a && !isBadVersion(t));
  const exact = sameArtist.filter((t) => tokenize(t.title).join('') === ti);
  const pool = exact.length ? exact : sameArtist.filter((t) => tokenize(t.title).join('').startsWith(ti));
  pool.sort((x, y) => (y.rank || 0) - (x.rank || 0));
  return pool[0] || null;
}

// Résout un morceau Last.fm (avec cache) : { track, listeners, year } ou null
async function resolveSong(lt, needYear) {
  const key = songKey(lt.artist, lt.title);
  const cached = data.songs[key];
  if (cached && (cached.track || Date.now() - cached.at < RETRY_FAILED_MS) && (!needYear || cached.yearChecked)) {
    return cached.track ? cached : null;
  }
  const info = cached && cached.listeners != null ? { listeners: cached.listeners, mbid: cached.mbid } : await lastfm.trackInfo(lt.artist, lt.title);
  let year = cached ? cached.year : null;
  let isrc = cached ? cached.isrc : null;
  let yearChecked = cached ? !!cached.yearChecked : false;
  if (needYear && !yearChecked) {
    const mb = await musicbrainz.recordingInfo({ mbid: lt.mbid || info.mbid, artist: lt.artist, title: lt.title });
    year = mb ? mb.year : null;
    isrc = (mb && mb.isrc) || isrc;
    yearChecked = true;
  }
  const track = cached && cached.track ? cached.track : await findOnDeezer({ artist: lt.artist, title: lt.title, isrc });
  const entry = {
    at: Date.now(), listeners: info.listeners, mbid: info.mbid || lt.mbid || null,
    year, isrc, yearChecked,
    track: track ? { ...track, preview: undefined } : null, // l'extrait est redemandé à chaque manche
  };
  data.songs[key] = entry;
  save();
  return entry.track ? entry : null;
}

// Construit (ou reconstruit) le catalogue d'un thème
async function buildTheme(theme) {
  const needYear = !!theme.years;
  const lists = [];
  for (const tag of theme.tags) {
    try { lists.push(await lastfm.tagTopTracks(tag, 2)); } catch (err) { console.warn(`Last.fm « ${tag} » :`, err.message); }
  }
  // Fusion des étiquettes, en alternant pour garder les meilleurs de chacune
  const seen = new Set();
  const candidates = [];
  for (let i = 0; candidates.length < MAX_TRACKS_PER_THEME * 1.3; i++) {
    let any = false;
    for (const list of lists) {
      if (i >= list.length) continue;
      any = true;
      const k = songKey(list[i].artist, list[i].title);
      if (!seen.has(k)) { seen.add(k); candidates.push(list[i]); }
    }
    if (!any) break;
  }

  const tracks = [];
  let rejected = 0;
  for (const lt of candidates) {
    if (tracks.length >= MAX_TRACKS_PER_THEME) break;
    const song = await resolveSong(lt, needYear);
    if (!song) continue;
    if (needYear) {
      const ok = song.year && song.year >= theme.years[0] && song.year <= theme.years[1] + 1;
      if (!ok) { rejected++; continue; }
    }
    tracks.push({ ...song.track, rank: song.listeners || song.track.rank || 0, year: song.year || null });
  }
  data.themes[theme.id] = { updatedAt: Date.now(), tracks };
  save();
  console.log(`Catalogue ${theme.label} : ${tracks.length} morceaux${needYear ? `, ${rejected} hors période écartés` : ''}`);
  return tracks;
}

// Morceaux d'un thème si son catalogue est prêt, sinon null (le jeu utilise alors l'ancien système)
function themeTracks(themeId) {
  const t = data.themes[themeId];
  return t && t.tracks.length >= MIN_TRACKS ? t.tracks : null;
}

// Tâche de fond : construit les thèmes manquants puis remet à jour ceux de plus d'une semaine
let running = false;
async function startBackgroundJob(themes) {
  if (running || !lastfm.enabled()) {
    if (!lastfm.enabled()) console.log('Pas de clé Last.fm : thèmes musicaux en mode playlists Deezer.');
    return;
  }
  running = true;
  try {
    const todo = themes.filter((t) => t.tags)
      .sort((a, b) => ((data.themes[a.id] || {}).updatedAt || 0) - ((data.themes[b.id] || {}).updatedAt || 0));
    for (const theme of todo) {
      const current = data.themes[theme.id];
      if (current && Date.now() - current.updatedAt < REFRESH_MS) continue;
      try { await buildTheme(theme); } catch (err) { console.warn(`Catalogue ${theme.label} :`, err.message); }
    }
  } finally {
    running = false;
  }
}

function status() {
  return Object.fromEntries(Object.entries(data.themes).map(([id, t]) => [id, { tracks: t.tracks.length, updatedAt: t.updatedAt }]));
}

module.exports = { themeTracks, startBackgroundJob, buildTheme, status };
