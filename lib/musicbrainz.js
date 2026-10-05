'use strict';

/*
  MusicBrainz : la base musicale ouverte de référence. On y lit la date de PREMIÈRE sortie
  d'un enregistrement (pas celle d'une compilation ou d'une réédition) et son code ISRC.
  Limite stricte : 1 requête par seconde, avec un User-Agent identifiable (voir CONTACT dans http.js).
*/

const { getJson, sleep } = require('./http');
const { tokenize } = require('./matching');

const BASE = 'https://musicbrainz.org/ws/2';
const SPACING_MS = 1100;
let lastCall = 0;

async function call(path) {
  const wait = lastCall + SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return getJson(`${BASE}${path}${path.includes('?') ? '&' : '?'}fmt=json`, { retries: 1, timeout: 15000 });
}

const yearOf = (date) => {
  const y = parseInt(String(date || '').slice(0, 4), 10);
  return y > 1900 ? y : null;
};
const compact = (s) => tokenize(s).join('');

// { year, isrc } d'un morceau, ou null si introuvable
async function recordingInfo({ mbid, artist, title }) {
  if (mbid) {
    try {
      const r = await call(`/recording/${mbid}?inc=isrcs`);
      const year = yearOf(r['first-release-date']);
      if (year) return { year, isrc: (r.isrcs || [])[0] || null };
    } catch { /* identifiant périmé : on passe à la recherche */ }
  }
  try {
    const q = `recording:"${String(title).replace(/"/g, '')}" AND artist:"${String(artist).replace(/"/g, '')}"`;
    const res = await call(`/recording?query=${encodeURIComponent(q)}&limit=15`);
    const wantedTitle = compact(title);
    const wantedArtist = compact(artist);
    const matches = (res.recordings || []).filter((r) => r.score >= 85
      && compact(r.title) === wantedTitle
      && (r['artist-credit'] || []).some((c) => compact(c.name || (c.artist && c.artist.name)) === wantedArtist));
    // La plus ancienne date de sortie parmi les enregistrements correspondants = la sortie originale
    let best = null;
    for (const r of matches) {
      const year = yearOf(r['first-release-date']);
      if (year && (!best || year < best.year)) best = { year, isrc: (r.isrcs || [])[0] || null };
    }
    return best;
  } catch {
    return null;
  }
}

module.exports = { recordingInfo };
