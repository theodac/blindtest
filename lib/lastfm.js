'use strict';

/*
  Last.fm : morceaux les plus écoutés pour un style (étiquettes posées par les auditeurs)
  et nombre d'auditeurs de chaque morceau. Limite : environ 5 requêtes par seconde.
*/

const { getJson, sleep } = require('./http');
const { LASTFM_API_KEY } = require('./config');

const BASE = 'https://ws.audioscrobbler.com/2.0/';
const SPACING_MS = 220;
let lastCall = 0;

async function call(params) {
  if (!LASTFM_API_KEY) throw new Error('pas de clé Last.fm configurée');
  const wait = lastCall + SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const url = `${BASE}?${new URLSearchParams({ ...params, api_key: LASTFM_API_KEY, format: 'json' })}`;
  const json = await getJson(url, { retries: 2 });
  if (json.error) throw new Error(`Last.fm : ${json.message || json.error}`);
  return json;
}

// Les morceaux les plus associés à une étiquette (« hard rock », « 80s », « french rap »…)
async function tagTopTracks(tag, pages = 2) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const json = await call({ method: 'tag.gettoptracks', tag, limit: 100, page });
    const list = (json.tracks && json.tracks.track) || [];
    for (const t of list) {
      out.push({
        title: t.name,
        artist: (t.artist && t.artist.name) || '',
        mbid: t.mbid || null,
        rank: Number(t['@attr'] && t['@attr'].rank) || out.length + 1,
      });
    }
    if (list.length < 100) break;
  }
  return out;
}

// Nombre d'auditeurs (popularité réelle) et identifiant MusicBrainz d'un morceau
async function trackInfo(artist, title) {
  try {
    const json = await call({ method: 'track.getInfo', artist, track: title, autocorrect: 1 });
    const t = json.track || {};
    return { listeners: Number(t.listeners) || 0, mbid: t.mbid || null };
  } catch {
    return { listeners: 0, mbid: null };
  }
}

const enabled = () => !!LASTFM_API_KEY;

module.exports = { tagTopTracks, trackInfo, enabled };
