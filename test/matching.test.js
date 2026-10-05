'use strict';
const assert = require('assert');
const { checkGuess, cleanTitle, cleanArtist } = require('../lib/matching');

const cases = [
  // [proposition, {artist, title}, artiste attendu, titre attendu]
  ['daft punk', { artist: 'Daft Punk', title: 'Get Lucky (feat. Pharrell Williams)' }, true, false],
  ['get lucky', { artist: 'Daft Punk', title: 'Get Lucky (feat. Pharrell Williams)' }, false, true],
  ['daft punk get lucky', { artist: 'Daft Punk', title: 'Get Lucky' }, true, true],
  ['daft pank', { artist: 'Daft Punk', title: 'Get Lucky' }, true, false],
  ['beatles', { artist: 'The Beatles', title: 'Let It Be - Remastered 2009' }, true, false],
  ['let it be', { artist: 'The Beatles', title: 'Let It Be - Remastered 2009' }, false, true],
  ['acdc', { artist: 'AC/DC', title: 'Highway to Hell' }, true, false],
  ['ac dc', { artist: 'AC/DC', title: 'Highway to Hell' }, true, false],
  ['stromae alors on danse', { artist: 'Stromae', title: 'Alors on danse' }, true, true],
  ['beyonce', { artist: 'Beyoncé', title: 'Halo' }, true, false],
  ['halo', { artist: 'Beyoncé', title: 'Halo' }, false, true],
  ['hola', { artist: 'Beyoncé', title: 'Halo' }, false, false],
  ['u2', { artist: 'U2', title: 'One' }, true, false],
  ['u3', { artist: 'U2', title: 'One' }, false, false],
  ['kesha', { artist: 'Ke$ha', title: 'TiK ToK' }, true, false],
  ['tik tok', { artist: 'Ke$ha', title: 'TiK ToK' }, false, true],
  ['indochine', { artist: 'Indochine', title: "L'aventurier" }, true, false],
  ['aventurier', { artist: 'Indochine', title: "L'aventurier" }, false, true],
  ['simon and garfunkel', { artist: 'Simon & Garfunkel', title: 'The Boxer' }, true, false],
  ['simon et garfunkel', { artist: 'Simon & Garfunkel', title: 'The Boxer' }, true, false],
  ['bonjour', { artist: 'Daft Punk', title: 'Get Lucky' }, false, false],
];

// Œuvres (films, séries, anime) avec alias
const works = [
  ['shingeki no kyojin', ["L'Attaque des Titans", 'Shingeki no Kyojin', 'SNK'], true],
  ['attaque des titans', ["L'Attaque des Titans", 'SNK'], true],
  ['snk', ["L'Attaque des Titans", 'SNK'], true],
  ['got', ['Game of Thrones', 'GOT'], true],
  ['game of throne', ['Game of Thrones', 'GOT'], true],
  ['le seigneur des anneaux', ['Le Seigneur des Anneaux', 'LOTR'], true],
  ['seigneur des aneaux', ['Le Seigneur des Anneaux', 'LOTR'], true],
  ['steins gate', ['Steins;Gate'], true],
  ['pokemon', ['Pokémon'], true],
  ['le bon la brute et le truand', ['Le Bon, la Brute et le Truand'], true],
  ['naruto', ['Naruto', 'Naruto Shippuden'], true],
  ['bleach', ['Naruto', 'Naruto Shippuden'], false],
  ['harry poter', ['Harry Potter'], true],
  // Lot 1 : romaji, nombres, chiffres romains
  ['naruto shippuden', ['Naruto: Shippuuden'], true],
  ['shingeki no kyoujin', ['Shingeki no Kyojin'], true],
  ['final fantasy 7', ['Final Fantasy VII'], true],
  ['final fantasy seven', ['Final Fantasy VII'], true],
  ['final fantasy 8', ['Final Fantasy VII'], false],
  ['rocky 2', ['Rocky II'], true],
  ['les deux tours', ['Les 2 Tours'], true],
  ['ocean s 11', ["Ocean's Eleven"], true],
  ['malcolm x', ['Malcolm X'], true],
  ['boku no hero academia', ['Boku no Hero Academia'], true],
];

let failed = 0;

// Nom d'œuvre tiré du titre d'album
const { workFromAlbum } = require('../lib/names');
const albums = [
  ['Interstellar (Original Motion Picture Soundtrack)', 'Interstellar', false],
  ['Stranger Things 4 (Music from the Netflix Series)', 'Stranger Things', true],
  ['Game of Thrones: Season 1 (Music from the HBO Series)', 'Game of Thrones', true],
  ['Intouchables (Bande originale du film)', 'Intouchables', false],
  ['100 Greatest Film Themes', null, null],
  ["Let's Talk About Love", null, null],
];
for (const [album, name, series] of albums) {
  const w = workFromAlbum(album);
  const ok = name === null ? w === null : w && w.name === name && w.isSeries === series;
  if (!ok) { failed++; console.log(`ÉCHEC album "${album}" : obtenu`, w); }
}
for (const [guess, variants, expected] of works) {
  const r = checkGuess(guess, { work: variants });
  if (r.work !== expected) { failed++; console.log(`ÉCHEC œuvre "${guess}" sur ${variants[0]} : obtenu ${r.work}`); }
}

for (const [guess, track, a, t] of cases) {
  const r = checkGuess(guess, { artist: [cleanArtist(track.artist)], title: [cleanTitle(track.title)] });
  try {
    assert.strictEqual(r.artist, a);
    assert.strictEqual(r.title, t);
  } catch {
    failed++;
    console.log(`ÉCHEC "${guess}" sur ${track.artist} – ${track.title} : obtenu`, r);
  }
}
console.log(failed ? `${failed} échec(s)` : `${cases.length + works.length + 6} cas OK`);
process.exit(failed ? 1 : 0);
