'use strict';

// Mots ignorés dans les réponses ("The Beatles" = "Beatles", "Les Rita Mitsouko" = "Rita Mitsouko")
const ARTICLES = new Set(['the', 'a', 'an', 'le', 'la', 'les', 'l', 'un', 'une', 'des', 'el', 'los', 'las']);

// Transforme une chaîne en liste de mots comparables
function tokenize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // accents
    .replace(/&/g, ' and ')
    .replace(/\$/g, 's')                               // Ke$ha, A$AP
    .replace(/['’`]/g, ' ')                            // l'amour -> l amour
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(canonical);
}

// Nombres écrits en lettres (français, anglais) et chiffres romains -> chiffres.
// Appliqué des deux côtés (réponse attendue et proposition), donc "Final Fantasy VII",
// "final fantasy 7" et "final fantasy seven" deviennent identiques.
const NUMBER_WORDS = {
  deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12,
  treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, trente: 30, cent: 100, mille: 1000,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, hundred: 100, thousand: 1000,
};
// "i", "v" et "x" seuls sont trop ambigus (I Will Survive, Malcolm X) : on ne les convertit pas
const ROMAN = { ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16 };

function canonical(word) {
  if (word === 'et') return 'and';
  if (NUMBER_WORDS[word]) return String(NUMBER_WORDS[word]);
  if (ROMAN[word]) return String(ROMAN[word]);
  if (/^\d+$/.test(word)) return String(Number(word)); // "07" -> "7"
  // Romanisation du japonais : Shippuuden / Shippuden, Kyoujin / Kyojin, Ryuuk / Ryuk, Oosaka / Osaka
  return word.replace(/ou/g, 'o').replace(/uu/g, 'u').replace(/oo/g, 'o').replace(/aa/g, 'a').replace(/ii/g, 'i');
}

function withoutArticles(tokens) {
  const kept = tokens.filter((w) => !ARTICLES.has(w));
  return kept.length ? kept : tokens; // un titre composé uniquement d'articles reste tel quel
}

// Retire les mentions parasites du titre : (Remastered 2011), [Live], - Radio Edit, feat. X
function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .trim();
}

function cleanArtist(artist) {
  return String(artist || '').replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '').trim();
}

function levenshtein(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Nombre de fautes tolérées selon la longueur de la réponse
function tolerance(len) {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  if (len <= 12) return 2;
  return 3;
}

// Vrai si la proposition contient la réponse (à quelques fautes près).
// Permet de taper "daft punk get lucky" pour trouver les deux d'un coup.
const digitsOf = (s) => s.replace(/\D+/g, ' ').trim();

function matches(guess, answer) {
  const answerTokens = withoutArticles(tokenize(answer));
  const target = answerTokens.join('');
  if (!target) return false;
  const guessTokens = withoutArticles(tokenize(guess));
  if (!guessTokens.length) return false;
  const tol = tolerance(target.length);

  const n = answerTokens.length;
  // On teste des fenêtres de n-1 à n+1 mots pour absorber "ac dc" / "acdc"
  for (let size = Math.max(1, n - 1); size <= n + 1; size++) {
    for (let i = 0; i + size <= guessTokens.length; i++) {
      const candidate = guessTokens.slice(i, i + size).join('');
      // Les chiffres doivent être exacts : "Final Fantasy 8" n'est pas une faute de frappe de "Final Fantasy 7"
      if (digitsOf(candidate) !== digitsOf(target)) continue;
      if (levenshtein(candidate, target, tol) <= tol) return true;
    }
  }
  return false;
}

// answers : { cle: [variantes acceptées] } -> { cle: true/false }
function checkGuess(guess, answers) {
  const result = {};
  for (const [key, variants] of Object.entries(answers)) {
    result[key] = variants.some((v) => matches(guess, v));
  }
  return result;
}

module.exports = { checkGuess, matches, tokenize, cleanTitle, cleanArtist };
