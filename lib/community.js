'use strict';

/*
  Thèmes de la communauté : n'importe quel joueur peut créer un thème, les autres l'aiment (👍)
  et l'ajoutent à leurs parties. Deux sortes :
  - "playlist" : une playlist Deezer publique (à trouver : artiste + titre)
  - "works"    : une liste d'œuvres écrite à la main, une par ligne :
                 Nom de l'œuvre | autre nom, autre nom | recherche Deezer (facultative)
                 (à trouver : le nom de l'œuvre ; l'extrait est cherché sur Deezer)
*/

const crypto = require('crypto');
const store = require('./store');
const deezer = require('./deezer');
const { parsePlaylistId } = deezer;

const WORK_LABELS = ['Film', 'Série', 'Jeu', 'Anime', 'Œuvre'];
const MAX_THEMES_PER_CREATOR = 20;

const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function parseEntries(text) {
  const entries = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const [name, aliases, q] = line.split('|').map((x) => (x || '').trim());
    if (!name) continue;
    entries.push({
      name: clean(name, 80),
      aliases: (aliases || '').split(',').map((a) => clean(a, 80)).filter(Boolean).slice(0, 6),
      q: clean(q, 120),
    });
    if (entries.length >= 300) break;
  }
  return entries;
}

function create(input = {}) {
  const name = clean(input.name, 40);
  const description = clean(input.description, 140);
  const creator = clean(input.creator, 20) || 'Anonyme';
  const key = String(input.key || '').slice(0, 64);
  if (name.length < 3) return { ok: false, error: 'Donne un nom d’au moins 3 caractères à ton thème.' };
  if (!key) return { ok: false, error: 'Identifiant manquant, recharge la page.' };
  const mine = Object.values(store.db.themes).filter((t) => t.creatorKey === key).length;
  if (mine >= MAX_THEMES_PER_CREATOR) return { ok: false, error: `Tu as déjà créé ${MAX_THEMES_PER_CREATOR} thèmes.` };

  const theme = {
    id: crypto.randomBytes(4).toString('hex'),
    name, description, creator, creatorKey: key,
    createdAt: Date.now(), likes: {}, plays: 0,
  };
  if (input.kind === 'playlist') {
    const playlistId = parsePlaylistId(input.playlist);
    if (!playlistId) return { ok: false, error: 'Lien de playlist Deezer non reconnu.' };
    Object.assign(theme, { kind: 'playlist', playlistId });
  } else {
    const entries = parseEntries(input.entries);
    if (entries.length < 5) return { ok: false, error: 'Il faut au moins 5 œuvres (une par ligne).' };
    const workLabel = WORK_LABELS.includes(input.workLabel) ? input.workLabel : 'Œuvre';
    Object.assign(theme, { kind: 'works', workLabel, entries });
  }
  store.db.themes[theme.id] = theme;
  store.save();
  return { ok: true, id: theme.id };
}

function publicTheme(t, key) {
  return {
    id: t.id, name: t.name, description: t.description, creator: t.creator,
    kind: t.kind, workLabel: t.workLabel || null,
    count: t.kind === 'works' ? t.entries.length : null,
    likes: Object.keys(t.likes).length, liked: !!t.likes[key], plays: t.plays,
    mine: t.creatorKey === key,
  };
}

// Les plus aimés d'abord, puis les plus joués, puis les plus récents
function list(key, query = '') {
  const q = clean(query, 40).toLowerCase();
  return Object.values(store.db.themes)
    .filter((t) => !q || `${t.name} ${t.description} ${t.creator}`.toLowerCase().includes(q))
    .map((t) => publicTheme(t, key))
    .sort((a, b) => b.likes - a.likes || b.plays - a.plays)
    .slice(0, 60);
}

function toggleLike(id, key) {
  const t = store.db.themes[id];
  if (!t || !key) return false;
  if (t.likes[key]) delete t.likes[key];
  else t.likes[key] = 1;
  store.save();
  return true;
}

function remove(id, key) {
  const t = store.db.themes[id];
  if (!t || t.creatorKey !== key) return false;
  delete store.db.themes[id];
  store.save();
  return true;
}

const get = (id) => store.db.themes[id] || null;

function countPlay(id) {
  const t = store.db.themes[id];
  if (t) { t.plays++; store.save(); }
}

// Éléments jouables d'un thème de la communauté
async function pool(t, { dedupeSongs }) {
  if (t.kind === 'playlist') {
    const tracks = dedupeSongs(await deezer.loadTracks(`playlist:${t.playlistId}`));
    return tracks.map((track) => ({ type: 'track', track }));
  }
  return t.entries.map((e) => ({ type: 'custom', name: e.name, aliases: e.aliases, q: e.q, label: t.workLabel }));
}

module.exports = { create, list, toggleLike, remove, get, countPlay, pool, WORK_LABELS };
