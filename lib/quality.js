'use strict';

/*
  Écarte les versions qui font de mauvais extraits de blind test :
  live, karaoké, instrumental, remix, accéléré/ralenti, reprises « à la manière de »…
  et, pour les BO, les pistes trop courtes (jingles, transitions).
*/

const BAD_TITLE = new RegExp([
  '\\blive\\b', 'en concert', '\\bkaraok[eé]', 'instrumental', '\\bremix', '\\brmx\\b', 'acoustic', 'acoustique',
  'a cappella', 'acapella', 'sped up', 'speed up', 'slowed', 'reverb', 'nightcore', '\\b8d\\b', 'lofi', 'lo-fi',
  '\\bskit\\b', 'interlude', 'made famous', 'originally performed', 'in the style of', 'tribute', '\\bcover\\b',
  'version piano', 'piano version', 'lullaby', 'berceuse', 'demo version', 'commentary',
].join('|'), 'i');

// Ces mentions sont suspectes n'importe où dans le titre
const BAD_ANYWHERE = /(karaok[eé]|made famous|originally performed|in the style of|nightcore|sped up|slowed (and|&) reverb)/i;

// Les autres ("live", "remix"…) seulement dans la partie "version" du titre :
// entre parenthèses/crochets ou après un tiret. "Live and Let Die" reste donc valide.
function versionPart(title) {
  const inBrackets = (title.match(/[([][^)\]]*[)\]]/g) || []).join(' ');
  const afterDash = title.split(/\s+[-–—]\s+/).slice(1).join(' ');
  return `${inBrackets} ${afterDash}`;
}

const BAD_ARTIST = /(karaoke|tribute|cover band|sing2|piano tribute|vitamin string quartet|rockabye baby|lullaby|8-bit|in the style of|twinkle twinkle|kids? (band|choir)|the hit crew|chillout lounge)/i;

const MIN_SCREEN_DURATION = 45; // secondes : en dessous, c'est souvent un jingle ou une transition

function isBadVersion(track, { screen = false } = {}) {
  const title = track.fullTitle || track.title || '';
  if (BAD_ANYWHERE.test(title) || BAD_TITLE.test(versionPart(title))) return true;
  // Pour les BO, une piste nommée simplement "Interlude" ou "Skit" est aussi écartée
  if (screen && /^(interlude|skit|intro|outro|transition)\b/i.test(title)) return true;
  if (BAD_ARTIST.test(track.artist || '')) return true;
  if (screen && track.duration && track.duration < MIN_SCREEN_DURATION) return true;
  return false;
}

module.exports = { isBadVersion };
