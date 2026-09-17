const express = require('express');
const https = require('https');
const zlib = require('zlib');
const readline = require('readline');
const app = express();
const PORT = process.env.PORT || 3000;
const KEY = process.env.TMDB_API_KEY;
const STREAM_KEY = process.env.STREAMING_API_KEY; // chiave RapidAPI "Streaming Availability API"

// --- OVERRIDE MANUALI (rete di sicurezza per casi che nessuna fonte pubblica traccia) ---
const OVERRIDES = {
  '567604': true,   // C'era una volta Deadpool - nessuna fonte traccia questa riedizione come release separata
  '945937': true     // Fast Charlie - confermato uscito
};

const MANIFEST = {
  id: 'com.italyreleasechecker.nuvio',
  version: '3.5.0',
  name: '🇮🇹 Italy Release Checker',
  description: 'Controlla se un film ha un doppiaggio italiano (dataset IMDb + TMDB + Streaming Availability API).',
  resources: [
    { name: 'meta', types: ['movie'], idPrefixes: ['tmdb:', 'tt'] }
  ],
  types: ['movie'],
  idPrefixes: ['tmdb:', 'tt']
};

app.get('/', (q, r) => r.json({ name: MANIFEST.name, version: MANIFEST.version, status: 'ok' }));
app.get('/manifest.json', (q, r) => r.json(MANIFEST));

// ============ INDICE IMDb (title.akas.tsv.gz, region=IT) ============
let itIndex = new Uint32Array(0);
let itIndexBuiltAt = null;
let itIndexBuilding = false;
const STRONG_TYPES = ['imdbDisplay', 'festival', 'tv', 'video', 'dvd'];

function buildItIndex() {
  if (itIndexBuilding) return;
  itIndexBuilding = true;
  const ids = [];
  https.get('https://datasets.imdbws.com/title.akas.tsv.gz', res => {
    if (res.statusCode !== 200) { console.error('IT index: HTTP ' + res.statusCode); itIndexBuilding = false; return; }
    const gunzip = zlib.createGunzip();
    res.pipe(gunzip);
    const rl = readline.createInterface({ input: gunzip });
    let first = true;
    rl.on('line', line => {
      if (first) { first = false; return; }
      const tab1 = line.indexOf('\t');
      if (tab1 === -1) return;
      const titleId = line.slice(0, tab1);
      if (titleId.charCodeAt(0) !== 116) return;
      const parts = line.split('\t');
      if (parts[3] !== 'IT') return;
      const types = parts[5];
      if (!types || types === '\\N') return;
      const typeList = types.split(',');
      if (!STRONG_TYPES.some(t => typeList.includes(t))) return;
      if (/^tt\d+$/.test(titleId)) ids.push(parseInt(titleId.slice(2), 10));
    });
    rl.on('close', () => {
      ids.sort((a, b) => a - b);
      itIndex = Uint32Array.from(ids);
      itIndexBuiltAt = new Date();
      itIndexBuilding = false;
      console.log('IT index: ' + itIndex.length + ' titoli, ' + itIndexBuiltAt.toISOString());
    });
    rl.on('error', e => { console.error('IT index readline error: ' + e.message); itIndexBuilding = false; });
    gunzip.on('error', e => { console.error('IT index gunzip error: ' + e.message); itIndexBuilding = false; });
  }).on('error', e => { console.error('IT index download error: ' + e.message); itIndexBuilding = false; });
}

function imdbAkaIT(imdbId) {
  if (!imdbId || itIndex.length === 0) return false;
  const m = /^tt(\d+)$/.exec(imdbId);
  if (!m) return false;
  const target = parseInt(m[1], 10);
  let lo = 0, hi = itIndex.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (itIndex[mid] === target) return true;
    if (itIndex[mid] < target) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}

buildItIndex();
setInterval(buildItIndex, 24 * 60 * 60 * 1000);
app.get('/status', (q, r) => r.json({ it_index_titles: itIndex.length, built_at: itIndexBuiltAt, building: itIndexBuilding, streaming_api_configured: !!STREAM_KEY }));

// ============ TMDB ============
async function tmdb(path) {
  if (!KEY) return null;
  const u = new URL('https://api.themoviedb.org/3' + path);
  u.searchParams.set('api_key', KEY);
  u.searchParams.set('language', 'it-IT');
  const r = await fetch(u);
  return r.ok ? r.json() : null;
}

async function resolveTmdbId(rawId) {
  const id = String(rawId || '');
  if (/^tmdb:\d+$/.test(id)) return id.slice(5);
  if (/^\d+$/.test(id)) return id;
  if (/^tt\d+$/.test(id)) {
    const found = await tmdb('/find/' + id + '?external_source=imdb_id');
    return found?.movie_results?.[0]?.id ? String(found.movie_results[0].id) : null;
  }
  return null;
}

// Solo tipi che in Italia implicano storicamente doppiaggio: premiere/cinema/TV. Esclude digital/physical
// perché tanti titoli VOD arrivano in lingua originale con soli sub.
async function tmdbTheatricalTvIT(id) {
  const d = await tmdb('/movie/' + id + '/release_dates');
  const it = (d?.results || []).find(x => x.iso_3166_1 === 'IT');
  return !!it?.release_dates?.some(x => x.release_date && [1, 2, 3, 6].includes(x.type));
}

async function wikidataIT(imdbId) {
  if (!imdbId) return false;
  try {
    const q = `SELECT ?place WHERE {?item wdt:P345 "${imdbId}". ?item p:P577 ?st. ?st pq:P291 ?place.} LIMIT 50`;
    const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), {
      headers: { accept: 'application/sparql-results+json', 'user-agent': 'ItalyReleaseChecker/3.4' }
    });
    if (!r.ok) return false;
    const bindings = (await r.json()).results?.bindings || [];
    const places = [];
    for (const x of bindings) {
      const p = x.place?.value?.split('/').pop();
      if (p === 'Q38') return true;
      if (/^Q\d+$/.test(p)) places.push(p);
    }
    if (!places.length) return false;
    // Tutte le verifiche "è in Italia?" in parallelo invece che una alla volta
    const checks = await Promise.allSettled(places.map(p => {
      const q2 = `ASK { wd:${p} (wdt:P17|wdt:P131)* wd:Q38 }`;
      return fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q2), {
        headers: { accept: 'application/sparql-results+json', 'user-agent': 'ItalyReleaseChecker/3.4' }
      }).then(rr => rr.ok ? rr.json() : { boolean: false });
    }));
    return checks.some(c => c.status === 'fulfilled' && c.value?.boolean === true);
  } catch {
    return false;
  }
}

// ============ Streaming Availability API (movieofthenight, via RapidAPI) ============
// Unica fonte che dice esplicitamente se una piattaforma IT ha traccia AUDIO italiana
// (non solo sottotitoli). Cerca ricorsivamente qualsiasi campo "audio*" che contenga "it".
function isItalianLang(v) {
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === 'it' || s === 'ita' || s.startsWith('it-') || s.startsWith('ita-');
}

function findItalianAudio(obj, seen) {
  seen = seen || new Set();
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return false;
  seen.add(obj);
  for (const [k, v] of Object.entries(obj)) {
    if (/audio/i.test(k)) {
      const arr = Array.isArray(v) ? v : [v];
      for (const item of arr) {
        if (typeof item === 'string' && isItalianLang(item)) return true;
        if (item && typeof item === 'object') {
          if (isItalianLang(item.language) || isItalianLang(item.languageCode) || isItalianLang(item.locale)) return true;
        }
      }
    }
    if (v && typeof v === 'object' && findItalianAudio(v, seen)) return true;
  }
  return false;
}

let lastStreamingRaw = null; // per debug

async function streamingAudioIT(tmdbId) {
  if (!STREAM_KEY) return { ok: true, released: false };
  try {
    const r = await fetch(`https://streaming-availability.p.rapidapi.com/shows/movie/${tmdbId}?country=it`, {
      headers: { 'X-RapidAPI-Key': STREAM_KEY, 'X-RapidAPI-Host': 'streaming-availability.p.rapidapi.com' }
    });
    if (r.status === 429) return { ok: false, released: false }; // quota mensile esaurita
    if (!r.ok) return { ok: true, released: false };
    const d = await r.json();
    lastStreamingRaw = d?.streamingOptions?.it || null;
    return { ok: true, released: findItalianAudio(d?.streamingOptions?.it || {}) };
  } catch {
    return { ok: true, released: false };
  }
}

// ============ CACHE (riduce chiamate ripetute alla Streaming API) ============
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 giorni
const releaseCache = new Map(); // tmdbId -> { releaseText, decidedBy, ts }
const fullResponseCache = new Map(); // id grezzo richiesto da Nuvio -> { json, ts } — evita ogni chiamata esterna sui film già aperti

// ============ META ============
app.get('/meta/movie/:id.json', async (req, res) => {
  try {
    // Cache "veloce": se conosciamo già la risposta completa per QUESTO id, la ritorniamo
    // subito senza toccare TMDB/Wikidata/Streaming API (velocità massima sui film già aperti).
    const fast = fullResponseCache.get(req.params.id);
    if (!req.query.debug && fast && (Date.now() - fast.ts) < CACHE_TTL_MS) {
      return res.json(fast.json);
    }

    const tmdbId = await resolveTmdbId(req.params.id);
    if (!tmdbId) return res.status(404).json({ meta: null, error: 'ID non risolvibile' });
    const m = await tmdb('/movie/' + tmdbId);
    if (!m) return res.status(404).json({ meta: null, error: 'Movie not found' });

    if (Object.prototype.hasOwnProperty.call(OVERRIDES, tmdbId)) {
      const releaseText = OVERRIDES[tmdbId] ? '🇮🇹 USCITO IN ITALIA (doppiato)' : '🚫 NON USCITO IN ITALIA';
      const resp = { meta: buildMeta(req.params.id, tmdbId, m, releaseText) };
      fullResponseCache.set(req.params.id, { json: resp, ts: Date.now() });
      return res.json(resp);
    }

    const cached = releaseCache.get(tmdbId);
    let releaseText, cacheHit = false, quotaExhausted = false;
    let dTmdb = { status: 'fulfilled', value: undefined }, dWiki = { status: 'fulfilled', value: undefined }, dStream = { status: 'fulfilled', value: undefined };

    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
      releaseText = cached.releaseText;
      cacheHit = true;
    } else {
      [dTmdb, dWiki] = await Promise.allSettled([tmdbTheatricalTvIT(tmdbId), wikidataIT(m.imdb_id)]);
      let released = (dTmdb.status === 'fulfilled' && dTmdb.value) || (dWiki.status === 'fulfilled' && dWiki.value);
      let decidedBy = dTmdb.status === 'fulfilled' && dTmdb.value ? 'tmdb_theatrical_tv'
        : (dWiki.status === 'fulfilled' && dWiki.value ? 'wikidata' : null);
      if (!released) {
        const s = await streamingAudioIT(tmdbId);
        dStream = { status: 'fulfilled', value: s.released };
        quotaExhausted = !s.ok;
        released = s.released;
        decidedBy = released ? 'streaming_audio_it' : (quotaExhausted ? 'quota_esaurita' : 'nessuna_fonte');
      }
      releaseText = quotaExhausted && !released
        ? '⚠️ NON VERIFICABILE (quota API mensile esaurita)'
        : (released ? '🇮🇹 USCITO IN ITALIA (doppiato)' : '🚫 NON USCITO IN ITALIA');
      if (!quotaExhausted) releaseCache.set(tmdbId, { releaseText, decidedBy, ts: Date.now() });
    }
    const meta = buildMeta(req.params.id, tmdbId, m, releaseText);
    if (!quotaExhausted) fullResponseCache.set(req.params.id, { json: { meta }, ts: Date.now() });

    if (req.query.debug) {
      const sources = {
        imdb_akas_it_INFO_NON_USATO: imdbAkaIT(m.imdb_id),
        tmdb_theatrical_tv: dTmdb.status === 'fulfilled' ? dTmdb.value : 'error: ' + dTmdb.reason,
        wikidata: dWiki.status === 'fulfilled' ? dWiki.value : 'error: ' + dWiki.reason,
        streaming_audio_it: dStream.status === 'fulfilled' ? dStream.value : 'error: ' + dStream.reason,
        quota_exhausted: quotaExhausted,
        decided_by: cached ? (cached.decidedBy || 'cache (versione precedente)') : undefined
      };
      return res.json({ meta, cache_hit: cacheHit, debug: sources, streaming_raw_it: lastStreamingRaw });
    }
    res.json({ meta });
  } catch (e) {
    res.status(500).json({ meta: null, error: 'Release check failed' });
  }
});

function buildMeta(rawId, tmdbId, m, releaseText) {
  return {
    id: rawId.startsWith('tt') ? rawId : 'tmdb:' + tmdbId,
    type: 'movie',
    name: m?.title || m?.original_title,
    poster: m?.poster_path ? 'https://image.tmdb.org/t/p/w500' + m.poster_path : undefined,
    background: m?.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + m.backdrop_path : undefined,
    description: `${releaseText}${m?.overview ? '\n\n' + m.overview : ''}`,
    releaseInfo: releaseText,
    imdb_id: m?.imdb_id || undefined
  };
}

app.listen(PORT, () => console.log('Italy Release Checker 3.5 listening on ' + PORT));
