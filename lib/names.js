'use strict';

/*
  Outils pour deviner le nom d'une œuvre à partir des métadonnées en ligne.
*/

// Un album est une BO si son titre contient une de ces mentions
const SCREEN_MARK = /(soundtrack|banda sonora|motion picture|bande originale|bande-originale|\bb\.?o\.?\b|\bost\b|original score|music from|music inspired|musique (originale|du film|de la s[ée]rie)|from the (netflix|hbo|amazon|apple|disney|series|film|movie|original))/i;
const SERIES_MARK = /(series|s[ée]rie|television|\btv\b|season|saison|netflix|hbo|amazon original|apple tv|disney\+|showtime|\bamc\b|\bfx\b)/i;
// Compilations à écarter : on ne saurait pas quelle œuvre faire deviner
const COMPILATION = /(\bthemes?\b|\bhits\b|greatest|\bbest\b|collection|anthology|essential|ultimate|\btop\s?\d|blockbuster|cin[ée]ma|hollywood|movie music|film music|\bvol\.?\s?\d|various|compilation|\bclassics?\b)/i;

function clean(s) {
  return s.replace(/[“”"«»]/g, '').replace(/\s+/g, ' ').trim();
}

// "Interstellar (Original Motion Picture Soundtrack)" -> { name: 'Interstellar', isSeries: false }
// "Stranger Things 4 (Music from the Netflix Series)" -> { name: 'Stranger Things', isSeries: true }
function workFromAlbum(albumTitle) {
  const t = String(albumTitle || '').trim();
  if (!SCREEN_MARK.test(t)) return null;

  let name = t
    .replace(/^(bande[ -]originale|musique originale|musique|b\.?o\.?|ost)\s+(du film|de la s[ée]rie|de)?\s*:?\s*/i, '')
    .replace(/\s*[([].*$/, '')                                  // (Original Motion Picture Soundtrack)
    .replace(/\s+[-–—|]\s+.*$/, '')                              // - Music from the Series
    .replace(/\s*:\s*(season|saison|vol|volume|part|chapter|the original|original|music|soundtrack|ost|score|bande|songs?).*$/i, '')
    .replace(/\s+(season|saison|vol\.?|volume|part|chapter)\s*\d+.*$/i, '')
    .replace(/\s+(original\s+)?(motion picture\s+|television\s+|series\s+)?(soundtrack|score|ost)$/i, '');
  name = clean(name);
  const isSeries = SERIES_MARK.test(t);
  if (isSeries) name = name.replace(/\s+\d{1,2}$/, ''); // "Stranger Things 4" -> "Stranger Things"

  if (name.length < 2 || SCREEN_MARK.test(name) || COMPILATION.test(t)) return null;
  return { name, isSeries };
}

// Variantes acceptées pour un nom : "Naruto: Shippuden" accepte aussi "Naruto",
// "Attack on Titan Season 3" accepte aussi "Attack on Titan"
function nameVariants(name) {
  const out = new Set();
  const n = clean(String(name || ''));
  if (!n) return [];
  out.add(n);
  const noSeason = n
    .replace(/\s+(season|saison|part|cour)\s*\d+.*$/i, '')
    .replace(/\s+\d+(st|nd|rd|th)\s+season.*$/i, '')
    .replace(/\s+(final season|the final season).*$/i, '')
    .replace(/\s+(ii|iii|iv|2|3|4)$/i, '')
    .trim();
  if (noSeason.length >= 3) out.add(noSeason);
  const beforeColon = n.split(/\s*[:：]\s*/)[0].trim();
  if (beforeColon.length >= 4) out.add(beforeColon);
  return [...out];
}

module.exports = { workFromAlbum, nameVariants };
