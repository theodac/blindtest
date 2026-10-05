'use strict';

/*
  Thèmes alimentés en ligne, sans liste écrite à la main (voir THEMES plus bas).
  Les résultats sont gardés en cache quelques heures pour ne pas tout recharger à chaque partie.
*/

const deezer = require('./deezer');
const { popularAnime } = require('./anime');
const { frenchNames } = require('./wikidata');

// Année d'une œuvre : Wikidata d'abord, sinon date de sortie de l'album de BO sur Deezer.
// Au passage, on note sa popularité (nombre de Wikipédia qui en parlent).
async function workYear(item) {
  const wd = await frenchNames(item.name, item.kind);
  if (wd.sitelinks != null) item.sitelinks = wd.sitelinks;
  if (wd.year) return wd.year;
  return deezer.albumYear(item.tracks[0] && item.tracks[0].albumId);
}
const { workFromAlbum } = require('./names');
const { mapLimit } = require('./http');
const { weightedShuffle } = require('./popularity');
const { isBadVersion } = require('./quality');
const musiccatalog = require('./musiccatalog');
const { tokenize } = require('./matching');

/*
  Thèmes disponibles. Pour en ajouter un, il suffit d'une entrée ici.
  Thèmes musicaux : `tags` = étiquettes Last.fm utilisées pour constituer le catalogue (voir musiccatalog.js) ;
  `queries`, `years` et `genres` servent au système de secours (playlists Deezer) tant que le catalogue n'est pas prêt.
  - kind 'music'  : morceaux des playlists Deezer trouvées avec `queries` (à trouver : artiste + titre)
  - kind 'screen' : BO trouvées avec `queries`, le nom de l'œuvre vient du titre de l'album
                    (`work` = type d'œuvre, `series` = true/false pour trier séries et films, null = indifférent)
  - kind 'anime'  : anime populaires (MyAnimeList…) + openings (OP) ou endings (ED) d'AnimeThemes
  - kind 'chart'  : classement Deezer du moment
*/
const THEMES = [
  // `years` : l'album du morceau doit être sorti dans ces années (compilations écartées)
  // `genres` : l'album doit avoir un de ces genres Deezer (identifiants, ou nom reconnu par l'expression)
  { id: 'rapfr', tags: ['french rap', 'rap francais', 'rap français', 'french hip hop'], group: 'Musique', label: 'Rap FR', kind: 'music', queries: ['rap francais', 'rap fr hits', 'rap fr classiques', 'rap francais 2000', 'rap fr nouvelle generation', 'drill fr'], genres: { ids: [116], names: /rap|hip.?hop/i } },
  { id: 'variete', tags: ['chanson francaise', 'variete francaise', 'french pop', 'chanson'], group: 'Musique', label: 'Variété française', kind: 'music', queries: ['variete francaise', 'chanson francaise', 'tubes francais', 'variete francaise annees 80', 'chanson francaise classiques'], genres: { ids: [52, 132], names: /chanson|vari[eé]t|pop/i } },
  { id: '80s', tags: ['80s'], group: 'Musique', label: 'Années 80', kind: 'music', queries: ['annees 80', 'hits 80s', 'tubes annees 80', '80s hits'], years: [1980, 1989] },
  { id: '90s', tags: ['90s'], group: 'Musique', label: 'Années 90', kind: 'music', queries: ['annees 90', 'hits 90s', 'tubes annees 90', '90s hits'], years: [1990, 1999] },
  { id: '2000s', tags: ['00s', '2000s'], group: 'Musique', label: 'Années 2000', kind: 'music', queries: ['annees 2000', 'hits 2000s', 'tubes annees 2000', '2000s hits'], years: [2000, 2009] },
  { id: '2010s', tags: ['2010s'], group: 'Musique', label: 'Années 2010', kind: 'music', queries: ['annees 2010', 'hits 2010s', 'tubes annees 2010', '2010s hits'], years: [2010, 2019] },
  { id: 'rapus', tags: ['hip-hop', 'rap', 'hip hop', 'east coast rap', 'west coast rap', 'trap'], group: 'Musique', label: 'Rap US', kind: 'music', queries: ['rap us', 'hip hop classics', 'rap us 2000', 'hip hop hits'], genres: { ids: [116], names: /rap|hip.?hop/i } },
  { id: 'pop', tags: ['pop', 'dance-pop', 'pop rock'], group: 'Musique', label: 'Pop internationale', kind: 'music', queries: ['pop hits', 'pop internationale', 'top pop', 'pop 2010s'], genres: { ids: [132], names: /pop/i } },
  { id: 'rock', tags: ['rock', 'classic rock', 'hard rock', 'alternative rock', 'metal', 'punk rock', 'heavy metal', 'grunge'], group: 'Musique', label: 'Rock / Métal', kind: 'music', queries: ['classic rock', 'rock classics', 'hard rock', 'metal classics', 'rock alternatif', 'punk rock', 'heavy metal'], genres: { ids: [152, 85, 464], names: /rock|metal|punk|alternati|grunge/i } },
  { id: 'electro', tags: ['electronic', 'dance', 'house', 'french touch', 'edm', 'electro'], group: 'Musique', label: 'Électro / Dance', kind: 'music', queries: ['electro hits', 'dance hits', 'edm hits', 'french touch'], genres: { ids: [106, 113], names: /electro|dance|house|techno/i } },
  { id: 'afro', tags: ['afrobeats', 'reggaeton', 'latin', 'afrobeat', 'latin pop'], group: 'Musique', label: 'Afro / Latino', kind: 'music', queries: ['afro hits', 'afrobeats', 'reggaeton hits', 'latino hits'], genres: { ids: [2, 197], names: /afri|latin|reggaeton|dancehall|reggae/i } },
  { id: 'kpop', tags: ['k-pop', 'kpop'], group: 'Musique', label: 'K-pop', kind: 'music', queries: ['k-pop hits', 'kpop', 'kpop 2020'] },
  { id: 'hits', group: 'Musique', label: 'Hits du moment', kind: 'chart' },

  { id: 'films', group: 'Écrans', label: 'Films', kind: 'screen', work: 'film', series: false, queries: ['musique de film', 'bandes originales films', 'movie soundtracks', 'film scores', 'BO films cultes'] },
  { id: 'series', group: 'Écrans', label: 'Séries', kind: 'screen', work: 'series', series: true, queries: ['generique serie', 'series tv soundtrack', 'netflix series soundtrack', 'generiques series tv', 'tv series music', 'hbo series soundtrack'] },
  { id: 'disney', group: 'Écrans', label: 'Disney / Pixar', kind: 'screen', work: 'disney', series: false, queries: ['disney', 'chansons disney', 'disney classics', 'disney pixar soundtrack', 'disney en francais'] },
  { id: 'games', group: 'Écrans', label: 'Jeux vidéo', kind: 'screen', work: 'game', series: null, queries: ['video game music', 'musique jeux video', 'video game soundtrack', 'nintendo music', 'gaming ost'] },

  { id: 'anime', group: 'Anime', label: 'Openings anime', kind: 'anime', themeType: 'OP' },
  { id: 'anime-ed', group: 'Anime', label: 'Endings anime', kind: 'anime', themeType: 'ED' },
];
// Famille visuelle de chaque thème (couleur de l'interface pendant l'extrait)
for (const t of THEMES) {
  t.family = t.kind === 'anime' ? 'anime'
    : t.kind === 'screen' ? ({ disney: 'disney', game: 'game' }[t.work] || 'screen')
      : 'music';
}
const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]));
const PLAYLISTS_PER_QUERY = 3;
const PAGES_PER_PLAYLIST = 2; // 200 morceaux max par playlist
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const cache = new Map();
const building = new Map(); // évite de lancer deux fois le même chargement en parallèle

async function cached(key, build, ttl = CACHE_TTL_MS) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.items;
  if (building.has(key)) return building.get(key);
  const promise = (async () => {
    try {
      const items = await build();
      if (items.length) cache.set(key, { at: Date.now(), items });
      return items.length || !hit ? items : hit.items;
    } catch (err) {
      // Si la source est en panne, on garde l'ancienne liste plutôt que de tout bloquer
      if (hit) { console.warn(`${key} : source en panne, ancienne liste conservée`); return hit.items; }
      throw err;
    } finally {
      building.delete(key);
    }
  })();
  building.set(key, promise);
  return promise;
}

async function tracksFromQueries(queries) {
  const idLists = await mapLimit(queries, 2, (q) => deezer.searchPlaylists(q, PLAYLISTS_PER_QUERY));
  const playlistIds = [...new Set(idLists.flat().filter(Boolean))];
  const lists = await mapLimit(playlistIds, 3, (id) => deezer.loadTracks(`playlist:${id}`, PAGES_PER_PLAYLIST));
  const byId = new Map();
  for (const t of lists.flat().filter(Boolean)) byId.set(t.id, t);
  return [...byId.values()];
}

async function buildTheme(theme) {
  if (theme.kind === 'music') {
    // Système de secours (catalogue pas encore prêt) : l'album de chaque morceau est vérifié
    // au moment de le jouer (une requête), plutôt que des centaines d'un coup avant la partie
    const check = theme.years || theme.genres ? { years: theme.years, genres: theme.genres } : null;
    return dedupeSongs(await tracksFromQueries(theme.queries)).map((track) => ({ type: 'track', track, check }));
  }
  if (theme.kind === 'chart') return dedupeSongs(await deezer.loadTracks('chart:0')).map((track) => ({ type: 'track', track }));
  if (theme.kind === 'screen') {
    const tracks = (await tracksFromQueries(theme.queries)).filter((t) => !isBadVersion(t, { screen: true }));
    return enrich(screenItems(tracks, theme));
  }
  throw new Error('type de thème inconnu');
}

/*
  Vérifie chaque morceau grâce à son album : année de sortie (thèmes « Années 80 »…) et genre
  (Rock / Métal, Rap…). Les playlists trouvées par recherche contiennent souvent des intrus
  (du Goldman dans une playlist « années 2010 ») : ils sont écartés ici.
  Un morceau dont l'album est inconnu ou une compilation n'est gardé que si le thème manque de morceaux sûrs.
*/
const MIN_SURE_TRACKS = 40;

function albumMatches(info, theme) {
  if (!info) return null;
  const verdicts = [];
  if (theme.years) {
    if (!info.year || info.recordType === 'compile') verdicts.push(null);
    // +1 an de tolérance : un single de décembre 1989 sort souvent sur un album daté de 1990
    else verdicts.push(info.year >= theme.years[0] && info.year <= theme.years[1] + 1);
  }
  if (theme.genres) {
    if (!info.genreIds.length && !info.genreNames) verdicts.push(null);
    else verdicts.push(info.genreIds.some((id) => theme.genres.ids.includes(id)) || theme.genres.names.test(info.genreNames));
  }
  if (verdicts.includes(false)) return false;
  return verdicts.includes(null) ? null : true;
}

async function filterByAlbum(tracks, theme) {
  if (!theme.years && !theme.genres) return tracks;
  const albumIds = [...new Set(tracks.map((t) => t.albumId).filter(Boolean))];
  const infos = new Map();
  await mapLimit(albumIds, 4, async (id) => infos.set(id, await deezer.albumInfo(id)));
  const sure = [];
  const unsure = [];
  let rejected = 0;
  for (const t of tracks) {
    const v = albumMatches(infos.get(t.albumId), theme);
    if (v === true) sure.push(t);
    else if (v === null) unsure.push(t);
    else rejected++;
  }
  console.log(`Thème ${theme.label} : ${sure.length} morceaux vérifiés, ${unsure.length} incertains, ${rejected} intrus écartés`);
  return sure.length >= MIN_SURE_TRACKS ? sure : [...sure, ...unsure];
}

// Écarte les mauvaises versions et garde une seule version de chaque chanson (la plus écoutée)
function dedupeSongs(tracks) {
  const best = new Map();
  for (const t of tracks) {
    if (isBadVersion(t)) continue;
    const key = songKey(t);
    const prev = best.get(key);
    if (!prev || (t.rank || 0) > (prev.rank || 0)) best.set(key, t);
  }
  return [...best.values()];
}

function songKey(track) {
  const title = String(track.title || '').replace(/\s*[([].*$/, '').replace(/\s+-\s+.*$/, '');
  return `${tokenize(track.artist).join('')}|${tokenize(title).join('')}`;
}

// Un item par œuvre (on garde plusieurs morceaux possibles pour varier)
function screenItems(tracks, theme) {
  const works = new Map();
  for (const track of tracks) {
    const work = workFromAlbum(track.albumTitle);
    if (!work) continue;
    if (theme.series !== null && work.isSeries !== theme.series) continue;
    const key = tokenize(work.name).join('');
    if (!works.has(key)) works.set(key, { type: 'screen', kind: theme.work, name: work.name, tracks: [] });
    works.get(key).tracks.push(track);
  }
  return [...works.values()];
}

// En arrière-plan : récupère l'année (et le titre français) de chaque œuvre sur Wikidata,
// pour que le filtre par période soit instantané lors des parties suivantes
function enrich(items) {
  mapLimit(items, 2, async (item) => {
    item.year = await workYear(item);
  }).then(() => console.log(`Années récupérées pour ${items.length} œuvres`));
  return items;
}

// Les éléments jouables d'un thème (chargés en ligne puis gardés en cache)
async function themePool(id) {
  const theme = THEME_BY_ID.get(id);
  if (!theme) throw new Error('thème inconnu');
  if (theme.kind === 'anime') {
    // Une seule liste d'anime partagée par les openings et les endings
    const list = await cached('anime-list', () => popularAnime());
    return list.map((a) => ({ ...a, themeType: theme.themeType }));
  }
  if (theme.kind === 'music') {
    // Catalogue Last.fm + MusicBrainz + Deezer s'il est prêt ; sinon, playlists Deezer en attendant
    const catalog = musiccatalog.themeTracks(id);
    if (catalog) return catalog.map((track) => ({ type: 'track', track }));
    return cached(`fallback:${id}`, () => buildTheme(theme), 30 * 60 * 1000);
  }
  return cached(id, () => buildTheme(theme));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { THEMES, THEME_BY_ID, themePool, workYear, songKey, dedupeSongs, filterByAlbum, albumMatches };
