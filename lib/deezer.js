'use strict';

const { getJson, sleep } = require('./http');

const API = 'https://api.deezer.com';

/*
  Limiteur de débit : Deezer refuse au-delà d'environ 50 requêtes par 5 secondes ("Quota limit exceeded").
  Toutes les requêtes passent par une file qui en laisse partir au plus 40 par fenêtre de 5 s.
  Deux priorités : les requêtes des parties en cours passent toujours avant celles du travail de fond
  (construction du catalogue, préchargement).
*/
const WINDOW_MS = 5000;
const MAX_PER_WINDOW = 40;
const sent = [];
const queues = { high: [], low: [] };
let pumping = false;

function schedule(low) {
  return new Promise((resolve) => {
    queues[low ? 'low' : 'high'].push(resolve);
    pump();
  });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queues.high.length || queues.low.length) {
      const now = Date.now();
      while (sent.length && now - sent[0] > WINDOW_MS) sent.shift();
      if (sent.length >= MAX_PER_WINDOW) {
        await sleep(WINDOW_MS - (now - sent[0]) + 30);
        continue;
      }
      sent.push(now);
      (queues.high.shift() || queues.low.shift())();
    }
  } finally {
    pumping = false;
  }
}

// `low` : requête de fond, servie après celles des parties en cours
async function dz(url, { low = false, retries = 3 } = {}) {
  await schedule(low);
  const json = await getJson(url);
  if (json.error) {
    if (json.error.code === 4 && retries > 0) { // quota dépassé malgré tout : on patiente
      await sleep(3000);
      return dz(url, { low, retries: retries - 1 });
    }
    throw new Error(json.error.code === 4 ? 'Deezer est momentanément surchargé' : json.error.message || 'erreur Deezer');
  }
  return json;
}

function toTrack(t) {
  return {
    id: t.id,
    title: t.title_short || t.title,
    fullTitle: t.title,
    artist: (t.artist && t.artist.name) || '',
    albumTitle: (t.album && t.album.title) || '',
    albumId: (t.album && t.album.id) || null,
    rank: t.rank || 0, // score de popularité Deezer
    duration: t.duration || 0,
    cover: (t.album && (t.album.cover_big || t.album.cover_medium)) || '',
    preview: t.preview,
    link: t.link,
  };
}

// source : "chart:<genreId>" ou "playlist:<playlistId>"
async function loadTracks(source, maxPages = 5, low = false) {
  let url;
  if (source.startsWith('chart:')) url = `${API}/chart/${Number(source.slice(6)) || 0}/tracks?limit=100`;
  else if (source.startsWith('playlist:')) url = `${API}/playlist/${encodeURIComponent(source.slice(9))}/tracks?limit=100`;
  else throw new Error('source inconnue');

  const byId = new Map();
  for (let page = 0; url && page < maxPages; page++) {
    const json = await dz(url, { low });
    for (const t of json.data || []) {
      if (t.preview && t.readable !== false && !byId.has(t.id)) byId.set(t.id, toTrack(t));
    }
    url = json.next;
  }
  return [...byId.values()];
}

// Playlists publiques correspondant à une recherche. Les playlists des éditeurs Deezer
// (plus cohérentes que celles des utilisateurs) passent en premier.
async function searchPlaylists(q, limit = 4, low = false) {
  const json = await dz(`${API}/search/playlist?q=${encodeURIComponent(q)}&limit=25`, { low });
  const list = (json.data || []).filter((p) => p.nb_tracks >= 10);
  const isEditor = (p) => /deezer/i.test((p.user && p.user.name) || '');
  list.sort((a, b) => isEditor(b) - isEditor(a));
  return list.slice(0, limit).map((p) => p.id);
}

// Infos d'un album : année, type (album, single, compilation…) et genres. Gardées en mémoire.
const albumCache = new Map();
async function albumInfo(albumId, low = false) {
  if (!albumId) return null;
  if (albumCache.has(albumId)) return albumCache.get(albumId);
  try {
    const a = await dz(`${API}/album/${albumId}`, { low });
    const genres = (a.genres && a.genres.data) || [];
    const info = {
      year: parseInt(String(a.release_date || '').slice(0, 4), 10) || null,
      recordType: a.record_type || null,
      genreIds: [...new Set([a.genre_id, ...genres.map((g) => g.id)].filter((x) => x > 0))],
      genreNames: genres.map((g) => g.name).join(' '),
    };
    albumCache.set(albumId, info);
    return info;
  } catch {
    return null; // pas mis en cache : on réessaiera
  }
}

// Recherche de morceaux (q libre, ou syntaxe avancée : track:"..." artist:"...")
async function searchTracks(q, limit = 10, low = false) {
  const json = await dz(`${API}/search?q=${encodeURIComponent(q)}&limit=${limit}`, { low });
  return (json.data || []).filter((t) => t.preview && t.readable !== false).map(toTrack);
}

// Morceau exact à partir de son code ISRC (identifiant mondial d'un enregistrement)
async function trackByIsrc(isrc, low = false) {
  try {
    const t = await dz(`${API}/track/isrc:${encodeURIComponent(isrc)}`, { low });
    return t && t.id && t.preview && t.readable !== false ? toTrack(t) : null;
  } catch {
    return null;
  }
}

// Les URL d'extraits Deezer sont signées et expirent : on en redemande une juste avant la manche
async function freshPreview(trackId) {
  try {
    const json = await dz(`${API}/track/${trackId}`);
    return json.preview || null;
  } catch {
    return null;
  }
}

// Année de sortie d'un album (utile si Wikidata ne connaît pas l'œuvre)
async function albumYear(albumId) {
  if (!albumId) return null;
  try {
    const json = await dz(`${API}/album/${albumId}`);
    const y = parseInt(String(json.release_date || '').slice(0, 4), 10);
    return y > 1900 ? y : null;
  } catch {
    return null;
  }
}

// Accepte un ID ou un lien du type https://www.deezer.com/fr/playlist/1109890291
function parsePlaylistId(input) {
  const str = String(input || '').trim();
  if (/^\d{3,15}$/.test(str)) return str;
  const m = str.match(/deezer\.com\/(?:[a-z]{2}\/)?playlist\/(\d{3,15})/i);
  return m ? m[1] : null;
}

module.exports = { loadTracks, searchPlaylists, searchTracks, trackByIsrc, freshPreview, albumYear, albumInfo, parsePlaylistId };
