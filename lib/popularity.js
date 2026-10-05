'use strict';

/*
  Tirage pondéré par la popularité.
  Chaque élément reçoit un score de popularité normalisé entre 0 et 1 (échelle logarithmique,
  comparé aux autres éléments du même type), puis on mélange avec la méthode d'Efraimidis-Spirakis :
  clé = hasard^(1/poids). Les éléments populaires sortent bien plus souvent en premier,
  mais les autres gardent une chance d'apparaître.

  Sources de popularité :
  - anime : nombre de membres MyAnimeList / AniList / Kitsu (item.popularity)
  - rap, hits, playlists : score d'écoute Deezer (track.rank)
  - films, séries : nombre d'articles Wikipédia (item.sitelinks, via Wikidata),
    sinon le meilleur score d'écoute Deezer de la BO
*/

const STRENGTH = Number(process.env.POPULARITY_STRENGTH) || 3; // plus c'est haut, plus les populaires dominent
const FLOOR = 0.03;    // poids minimal : un élément obscur peut toujours sortir
const UNKNOWN = 0.35;  // score par défaut quand la popularité est inconnue

function rawScores(item) {
  if (item.type === 'track') return { main: item.track.rank };
  if (item.type === 'anime') return { main: item.popularity };
  if (item.type === 'screen') {
    const bestRank = Math.max(0, ...item.tracks.map((t) => t.rank || 0));
    return { main: item.sitelinks, backup: bestRank || null };
  }
  return {};
}

// Normalisation logarithmique entre 0 (le moins populaire du groupe) et 1 (le plus populaire),
// par groupe : on ne compare pas des membres MAL à des écoutes Deezer
function normalizer(values) {
  const logs = values.filter((v) => v > 0).map(Math.log);
  if (!logs.length) return () => null;
  const min = Math.min(...logs);
  const max = Math.max(...logs);
  return (v) => {
    if (!(v > 0)) return null;
    return max > min ? (Math.log(v) - min) / (max - min) : 1;
  };
}

function groupKey(item) {
  return item.type === 'screen' ? `screen:${item.kind}` : item.type;
}

// Calcule item.pop (0..1) pour chaque élément
function scorePopularity(items) {
  const groups = new Map();
  for (const it of items) {
    const k = groupKey(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  for (const group of groups.values()) {
    const raws = group.map(rawScores);
    const normMain = normalizer(raws.map((r) => r.main));
    const normBackup = normalizer(raws.map((r) => r.backup));
    group.forEach((it, i) => {
      const main = normMain(raws[i].main);
      const backup = normBackup(raws[i].backup);
      it.pop = main != null ? main : backup != null ? backup * 0.8 : UNKNOWN;
    });
  }
  return items;
}

function weight(pop) {
  return FLOOR + Math.pow(pop, STRENGTH);
}

// Mélange pondéré : renvoie une nouvelle liste, les plus populaires ayant tendance à être devant
function weightedShuffle(items) {
  scorePopularity(items);
  return items
    .map((it) => ({ it, key: Math.pow(Math.random(), 1 / weight(it.pop)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.it);
}

// Choix pondéré d'un seul élément (ex. quel morceau de la BO jouer)
function weightedPick(list, scoreOf) {
  const norm = normalizer(list.map(scoreOf));
  const weights = list.map((x) => weight(norm(scoreOf(x)) ?? UNKNOWN));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

module.exports = { weightedShuffle, weightedPick, scorePopularity };
