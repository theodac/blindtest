'use strict';

/*
  Wikidata (sans clé d'API) sert à récupérer le titre français et les autres noms d'une œuvre :
  "The Lion King" -> "Le Roi lion", "Shingeki no Kyojin" -> "L'Attaque des Titans"…
*/

const { getJson } = require('./http');

const API = 'https://www.wikidata.org/w/api.php';
const KIND_DESC = {
  film: /film|movie/i,
  series: /series|sitcom|television|tv show|drama/i,
  anime: /anime|manga|animated|television series/i,
  disney: /film|movie/i,
  game: /video game|jeu vidéo/i,
};
const cache = new Map();

// Année de sortie : date de publication (P577) ou date de début (P580, séries)
function yearOf(claims) {
  for (const prop of ['P577', 'P580']) {
    const years = (claims[prop] || [])
      .map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.time)
      .filter(Boolean)
      .map((t) => parseInt(t.slice(1, 5), 10))
      .filter((y) => y > 1880 && y < 2100);
    if (years.length) return Math.min(...years);
  }
  return null;
}

async function frenchNames(title, kind) {
  const key = `${kind}:${title}`;
  if (cache.has(key)) return cache.get(key);
  if (!KIND_DESC[kind]) return { fr: null, aliases: [], year: null, sitelinks: null }; // type d'œuvre inconnu
  let result = { fr: null, aliases: [], year: null, sitelinks: null };
  try {
    const search = await getJson(`${API}?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=7&search=${encodeURIComponent(title)}`, { timeout: 5000 });
    // Plusieurs candidats possibles (film original et remake…) : on garde le plus connu,
    // c'est-à-dire celui qui a des articles dans le plus de Wikipédia
    const hits = (search.search || []).filter((e) => KIND_DESC[kind].test(e.description || '')).slice(0, 3);
    if (hits.length) {
      const ids = hits.map((h) => h.id).join('|');
      const data = await getJson(`${API}?action=wbgetentities&format=json&props=labels|aliases|claims|sitelinks&languages=fr|en&ids=${ids}`, { timeout: 5000 });
      const ents = hits.map((h) => data.entities && data.entities[h.id]).filter(Boolean);
      const count = (e) => Object.keys(e.sitelinks || {}).length;
      const ent = ents.sort((a, b) => count(b) - count(a))[0];
      if (ent) {
        const fr = ent.labels && ent.labels.fr && ent.labels.fr.value;
        const aliases = [
          ...((ent.aliases && ent.aliases.fr) || []),
          ...((ent.aliases && ent.aliases.en) || []),
        ].map((a) => a.value);
        if (ent.labels && ent.labels.en) aliases.push(ent.labels.en.value);
        result = {
          fr: fr || null,
          aliases: aliases.filter((a) => a.length >= 2).slice(0, 12),
          year: yearOf(ent.claims || {}),
          sitelinks: count(ent),
        };
      }
    }
  } catch (err) {
    // Échec réseau : on ne met pas en cache, on réessaiera la prochaine fois
    console.warn('Wikidata indisponible :', err.message);
    return result;
  }
  cache.set(key, result);
  return result;
}

// Titre français déjà connu (sans appel réseau), ou null
function peekFrench(title, kind) {
  const hit = cache.get(`${kind}:${title}`);
  return hit ? hit.fr : null;
}

module.exports = { frenchNames, peekFrench };
