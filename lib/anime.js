'use strict';

/*
  Openings d'anime 100 % en ligne :
  - liste des anime populaires : top 500 de l'API officielle MyAnimeList (Client ID dans lib/config.js),
    sinon AniList, sinon Kitsu, sinon Jikan.
    Ces API ont régulièrement des pannes : on prend la première qui répond, en gardant les pages déjà reçues.
  - extrait : l'opening hébergé par AnimeThemes (recherche par identifiant AniList ou MyAnimeList)
*/

const { getJson, sleep } = require('./http');
const { MAL_CLIENT_ID } = require('./config');

const ANILIST = 'https://graphql.anilist.co';
const JIKAN = 'https://api.jikan.moe/v4';
const KITSU = 'https://kitsu.app/api/edge';
const MAL = 'https://api.myanimelist.net/v2';
const ANIMETHEMES = 'https://api.animethemes.moe';

const POPULAR_QUERY = `query ($page: Int) {
  Page(page: $page, perPage: 50) {
    media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
      id
      format
      popularity
      seasonYear
      startDate { year }
      title { romaji english }
      synonyms
      coverImage { large }
    }
  }
}`;

function franchiseKey(name) {
  return String(name).toLowerCase().split(/[:：]| season | part | \d+(st|nd|rd|th) season/)[0].replace(/[^a-z0-9]/g, '');
}

// Garde une seule entrée par franchise (pas 5 saisons de la même série)
function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = franchiseKey(it.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fromAniList(pages) {
  const items = [];
  for (let page = 1; page <= pages; page++) {
    let res;
    try {
      res = await getJson(ANILIST, { method: 'POST', body: { query: POPULAR_QUERY, variables: { page } }, retries: 1 });
      if (res.errors && res.errors.length) throw new Error(res.errors[0].message);
    } catch (err) {
      if (!items.length) throw err;
      break; // on garde les pages déjà reçues
    }
    for (const m of res.data.Page.media) {
      if (!['TV', 'MOVIE', 'ONA'].includes(m.format)) continue;
      items.push({
        type: 'anime', site: 'AniList', externalId: m.id, popularity: m.popularity || null,
        name: m.title.english || m.title.romaji,
        names: [m.title.english, m.title.romaji, ...(m.synonyms || [])].filter(Boolean),
        year: m.seasonYear || (m.startDate && m.startDate.year) || null,
        cover: m.coverImage && m.coverImage.large,
      });
    }
    await sleep(700); // AniList limite actuellement à 30 requêtes/minute
  }
  return items;
}

async function fromJikan(pages) {
  const items = [];
  for (let page = 1; page <= pages; page++) {
    let res;
    try {
      res = await getJson(`${JIKAN}/top/anime?filter=bypopularity&sfw=true&limit=25&page=${page}`, { retries: 3 });
    } catch (err) {
      if (!items.length) throw err;
      break;
    }
    for (const a of res.data || []) {
      if (!['TV', 'Movie', 'ONA'].includes(a.type)) continue;
      const titles = (a.titles || []).map((t) => t.title);
      items.push({
        type: 'anime', site: 'MyAnimeList', externalId: a.mal_id, popularity: a.members || null,
        name: a.title_english || a.title,
        names: [a.title_english, a.title, ...(a.title_synonyms || []), ...titles].filter(Boolean),
        year: a.year || (a.aired && a.aired.prop && a.aired.prop.from && a.aired.prop.from.year) || null,
        cover: a.images && a.images.jpg && a.images.jpg.large_image_url,
      });
    }
    await sleep(450); // Jikan : 3 requêtes/seconde max
  }
  return items;
}

// Top N par popularité sur MyAnimeList (500 max par requête)
async function fromMAL(count) {
  if (!MAL_CLIENT_ID) throw new Error('pas de Client ID MyAnimeList configuré');
  const fields = 'alternative_titles,start_season,media_type,main_picture,nsfw,num_list_users';
  const items = [];
  for (let offset = 0; offset < count; offset += 500) {
    const limit = Math.min(500, count - offset);
    const res = await getJson(
      `${MAL}/anime/ranking?ranking_type=bypopularity&limit=${limit}&offset=${offset}&fields=${fields}`,
      { headers: { 'X-MAL-CLIENT-ID': MAL_CLIENT_ID } },
    );
    for (const { node: a } of res.data || []) {
      if (a.nsfw === 'black' || !['tv', 'movie', 'ona'].includes(a.media_type)) continue;
      const alt = a.alternative_titles || {};
      items.push({
        type: 'anime', site: 'MyAnimeList', externalId: a.id, popularity: a.num_list_users || null,
        name: alt.en || a.title,
        names: [alt.en, a.title, ...(alt.synonyms || [])].filter(Boolean),
        year: (a.start_season && a.start_season.year) || null,
        cover: a.main_picture && (a.main_picture.large || a.main_picture.medium),
      });
    }
  }
  return items;
}

async function fromKitsu(pages) {
  const items = [];
  for (let page = 0; page < pages; page++) {
    let res;
    try {
      res = await getJson(
        `${KITSU}/anime?sort=popularityRank&page[limit]=20&page[offset]=${page * 20}&include=mappings`,
        { headers: { Accept: 'application/vnd.api+json' }, retries: 2 },
      );
    } catch (err) {
      if (!items.length) throw err;
      break;
    }
    const mappings = new Map((res.included || []).filter((x) => x.type === 'mappings').map((x) => [x.id, x.attributes]));
    for (const a of res.data || []) {
      const at = a.attributes || {};
      if (at.nsfw || !['TV', 'movie', 'ONA'].includes(at.subtype)) continue;
      const links = ((a.relationships && a.relationships.mappings && a.relationships.mappings.data) || [])
        .map((m) => mappings.get(m.id)).filter(Boolean);
      const anilist = links.find((m) => m.externalSite === 'anilist/anime');
      const mal = links.find((m) => m.externalSite === 'myanimelist/anime');
      const ref = anilist ? { site: 'AniList', externalId: anilist.externalId } : mal ? { site: 'MyAnimeList', externalId: mal.externalId } : null;
      if (!ref) continue;
      const titles = Object.values(at.titles || {});
      items.push({
        type: 'anime', ...ref, popularity: at.userCount || null,
        name: (at.titles && (at.titles.en || at.titles.en_us)) || at.canonicalTitle,
        names: [at.titles && at.titles.en, at.canonicalTitle, ...titles, ...(at.abbreviatedTitles || [])].filter(Boolean),
        year: at.startDate ? parseInt(at.startDate.slice(0, 4), 10) : null,
        cover: at.posterImage && (at.posterImage.large || at.posterImage.medium),
      });
    }
    await sleep(250);
  }
  return items;
}

// ~300 anime populaires (une entrée par franchise), en essayant les sources l'une après l'autre
async function popularAnime() {
  const sources = [
    ['MyAnimeList (API officielle)', () => fromMAL(500)],
    ['AniList', () => fromAniList(8)],
    ['Kitsu', () => fromKitsu(18)],
    ['Jikan', () => fromJikan(14)],
  ];
  let best = [];
  const errors = [];
  for (const [name, load] of sources) {
    try {
      const items = dedupe(await load());
      console.log(`Anime : ${items.length} reçus depuis ${name}`);
      if (items.length >= 100) return items;
      if (items.length > best.length) best = items;
    } catch (err) {
      errors.push(`${name} (${err.message})`);
      console.warn(`Anime : ${name} indisponible :`, err.message);
    }
  }
  if (best.length) return best;
  throw new Error(`aucune base d'anime ne répond : ${errors.join(', ')}`);
}

// Un opening (OP) ou ending (ED) au hasard pour un anime, ou null si AnimeThemes n'en a pas
async function randomOpening(item, themeType = 'OP') {
  const include = 'animethemes.animethemeentries.videos.audio,animethemes.song.artists';
  const url = `${ANIMETHEMES}/anime?filter[has]=resources&filter[site]=${item.site}&filter[external_id]=${item.externalId}&include=${include}`;
  const json = await getJson(url);
  const anime = (json.anime || [])[0];
  if (!anime) return null;

  const candidates = [];
  for (const theme of anime.animethemes || []) {
    if (theme.type !== themeType) continue;
    for (const entry of theme.animethemeentries || []) {
      if (entry.nsfw || entry.spoiler) continue;
      const video = (entry.videos || [])[0];
      if (!video) continue;
      candidates.push({
        audio: video.audio && video.audio.link,
        video: video.link,
        song: (theme.song && theme.song.title) || '',
        artist: ((theme.song && theme.song.artists) || []).map((a) => a.name).join(', '),
        id: `at-${video.id || video.basename}`,
      });
    }
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

module.exports = { popularAnime, randomOpening };
