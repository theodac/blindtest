'use strict';

/*
  Salles permanentes : un salon avec une adresse fixe (/salle/3bci) qui garde ses réglages,
  l'historique de ses parties et un classement cumulé de ses joueurs.
  La personne qui l'a créée (reconnue par l'identifiant de son navigateur) en redevient l'hôte
  chaque fois qu'elle entre.
*/

const store = require('./store');

const HISTORY_SIZE = 30;

function normalizeSlug(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}

const get = (slug) => store.db.salles[normalizeSlug(slug)] || null;

function create({ slug, title, ownerKey, settings }) {
  const s = normalizeSlug(slug);
  if (s.length < 3) return { ok: false, error: 'L’adresse doit faire au moins 3 caractères (lettres, chiffres, tirets).' };
  if (store.db.salles[s]) return { ok: false, error: 'Cette adresse est déjà prise.' };
  if (!ownerKey) return { ok: false, error: 'Identifiant manquant, recharge la page.' };
  store.db.salles[s] = {
    slug: s,
    title: String(title || s).replace(/\s+/g, ' ').trim().slice(0, 40) || s,
    ownerKey,
    settings: { ...settings },
    createdAt: Date.now(),
    history: [],
    totals: {},
  };
  store.save();
  return { ok: true, slug: s };
}

function saveSettings(slug, settings) {
  const salle = get(slug);
  if (!salle) return;
  salle.settings = { ...settings };
  store.save();
}

// Fin de partie : historique + classement cumulé (par pseudo)
function recordGame(slug, ranking, rounds) {
  const salle = get(slug);
  if (!salle || !ranking.length) return;
  salle.history.unshift({
    date: Date.now(),
    rounds,
    top: ranking.slice(0, 5).map((p) => ({ name: p.name, score: p.score })),
  });
  salle.history = salle.history.slice(0, HISTORY_SIZE);
  ranking.forEach((p, i) => {
    const t = salle.totals[p.name] || { points: 0, wins: 0, games: 0 };
    t.points += p.score;
    t.games += 1;
    if (i === 0 && p.score > 0) t.wins += 1;
    salle.totals[p.name] = t;
  });
  store.save();
}

function publicInfo(slug) {
  const salle = get(slug);
  if (!salle) return null;
  const leaderboard = Object.entries(salle.totals)
    .map(([name, t]) => ({ name, ...t }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);
  return { slug: salle.slug, title: salle.title, history: salle.history.slice(0, 5), leaderboard };
}

module.exports = { normalizeSlug, get, create, saveSettings, recordGame, publicInfo };
