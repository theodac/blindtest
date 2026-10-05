'use strict';

/*
  Propositions sous le champ de réponse (autocomplétion façon MovieGuessr).
  L'index contient TOUTES les réponses possibles des thèmes de la partie (pas seulement la bonne),
  pour ne rien dévoiler. Chaque entrée a un type (Film, Série, Jeu, Anime, Artiste, Chanson)
  qui permet de ne proposer que ce qui correspond à la question de la manche.
*/

const { tokenize } = require('./matching');
const { peekFrench } = require('./wikidata');

const KIND_LABEL = { film: 'Film', disney: 'Film', series: 'Série', game: 'Jeu', anime: 'Anime' };
const norm = (s) => tokenize(s).join(' ');

function buildIndex(items) {
  const entries = new Map(); // dédoublonnage par type + libellé
  const add = (label, kind, alt, pop) => {
    if (!label) return;
    const n = norm(label);
    if (!n) return;
    const key = `${kind}|${n}`;
    const prev = entries.get(key);
    if (prev) { prev.pop = Math.max(prev.pop, pop || 0); return; }
    entries.set(key, { label, kind, alt: alt || '', n, nAlt: alt ? norm(alt) : '', pop: pop || 0 });
  };

  for (const it of items) {
    const pop = it.pop || 0;
    if (it.type === 'track') {
      // Seulement l'artiste : proposer les titres de ses chansons donnerait presque la réponse
      add(it.track.artist, 'Artiste', '', pop);
    } else if (it.type === 'screen') {
      const fr = peekFrench(it.name, it.kind);
      if (fr && norm(fr) !== norm(it.name)) add(fr, KIND_LABEL[it.kind], it.name, pop);
      else add(it.name, KIND_LABEL[it.kind], '', pop);
    } else if (it.type === 'custom') {
      add(it.name, it.label, (it.aliases || [])[0] || '', pop);
    } else if (it.type === 'anime') {
      // Nom principal + un autre nom en alphabet latin (ex. Attack on Titan / Shingeki no Kyojin)
      const latin = (it.names || []).filter((n) => /[a-z]/i.test(n) && norm(n) !== norm(it.name));
      add(it.name, 'Anime', latin[0] || '', pop);
    }
  }
  return [...entries.values()];
}

// Types proposés selon ce que la manche demande
function kindsForRound(round) {
  if (!round) return null;
  if (round.targets.some((t) => t.key === 'artist')) return ['Artiste'];
  return round.targets.map((t) => t.label);
}

// Jusqu'à `limit` propositions : début du nom d'abord, puis début d'un mot, puis n'importe où ;
// à égalité, les plus populaires d'abord
function search(index, query, kinds, limit = 8) {
  const q = norm(query);
  if (q.length < 2) return [];
  const scored = [];
  for (const e of index) {
    if (kinds && !kinds.includes(e.kind)) continue;
    let rank = -1;
    for (const text of [e.n, e.nAlt]) {
      if (!text) continue;
      const r = text.startsWith(q) ? 0 : (` ${text}`).includes(` ${q}`) ? 1 : text.includes(q) ? 2 : -1;
      if (r >= 0 && (rank < 0 || r < rank)) rank = r;
    }
    if (rank >= 0) scored.push({ e, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || b.e.pop - a.e.pop || a.e.label.length - b.e.label.length);
  return scored.slice(0, limit).map(({ e }) => ({ label: e.label, kind: e.kind, alt: e.alt }));
}

module.exports = { buildIndex, kindsForRound, search };
