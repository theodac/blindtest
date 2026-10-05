'use strict';

// Wikidata demande un User-Agent identifiable avec un contact : renseigne CONTACT (ton e-mail) dans Render
const UA = `BlindTestParty/0.4 (jeu de blind test pedagogique${process.env.CONTACT ? `; ${process.env.CONTACT}` : ''}) node-fetch`;
// Les API anime sont derrière des protections anti-robots : on s'y présente comme un navigateur
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

/*
  Relais par le navigateur de l'hôte : certaines API (AniList, Kitsu…) bloquent les adresses IP
  des hébergeurs comme Render. Si le serveur est refusé, la même requête est envoyée au navigateur
  d'un hôte connecté, qui la fait depuis sa propre connexion et renvoie le résultat.
  Seuls ces domaines peuvent être relayés.
*/
const RELAY_HOSTS = /(^|\.)(anilist\.co|kitsu\.app|kitsu\.io|jikan\.moe|animethemes\.moe)$/;
let browserRelay = null;
function setBrowserRelay(fn) { browserRelay = fn; }

const relayStats = new Map(); // domaine -> nombre de refus côté serveur
function preferRelay(host) { return browserRelay && (relayStats.get(host) || 0) >= 2; }

async function getJson(url, opts = {}) {
  const host = new URL(url).hostname;
  const relayable = RELAY_HOSTS.test(host);
  // Domaine qui nous a déjà refusés plusieurs fois : on passe directement par le navigateur
  if (relayable && preferRelay(host)) {
    try { return await browserRelay(url, opts); } catch { /* on retente en direct */ }
  }
  try {
    return await directJson(url, { ...opts, retries: relayable && browserRelay ? Math.min(opts.retries ?? 2, 1) : opts.retries });
  } catch (err) {
    if (!relayable || !browserRelay || !/ 403| 5\d\d|injoignable|429/.test(err.message)) throw err;
    relayStats.set(host, (relayStats.get(host) || 0) + 1);
    try {
      const data = await browserRelay(url, opts);
      console.log(`${host} : requête relayée par le navigateur de l'hôte`);
      return data;
    } catch (relayErr) {
      throw new Error(`${err.message}, relais navigateur : ${relayErr.message}`);
    }
  }
}

// Réessaie automatiquement (avec une pause croissante) en cas d'erreur réseau, 429 ou 5xx
async function directJson(url, { method = 'GET', body, timeout = 10000, headers = {}, retries = 2 } = {}) {
  const ua = RELAY_HOSTS.test(new URL(url).hostname) ? BROWSER_UA : UA;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', 'User-Agent': ua, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (attempt < retries) { await sleep(1000 * (attempt + 1)); continue; }
      throw new Error(`${new URL(url).hostname} injoignable (${err.message})`);
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error(`${new URL(url).hostname} a répondu ${res.status}`);
  }
}

// Exécute fn sur chaque élément avec au plus `limit` appels en parallèle
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (err) { out[idx] = undefined; console.warn(err.message); }
    }
  });
  await Promise.all(workers);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { getJson, mapLimit, sleep, setBrowserRelay, RELAY_HOSTS };
