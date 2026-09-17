const express = require('express');
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
  version: '3.9.0',
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
app.get('/status', (q, r) => r.json({ streaming_api_configured: !!STREAM_KEY, persistent_cache_configured: !!(UPSTASH_URL && UPSTASH_TOKEN) }));

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

async function streamingAudioIT(tmdbId) {
  if (!STREAM_KEY) return { ok: true, released: false, raw: null };
  try {
    const r = await fetch(`https://streaming-availability.p.rapidapi.com/shows/movie/${tmdbId}?country=it`, {
      headers: { 'X-RapidAPI-Key': STREAM_KEY, 'X-RapidAPI-Host': 'streaming-availability.p.rapidapi.com' }
    });
    if (r.status === 429) return { ok: false, released: false, raw: null }; // quota mensile esaurita
    if (!r.ok) return { ok: true, released: false, raw: null };
    const d = await r.json();
    const raw = d?.streamingOptions?.it || null;
    return { ok: true, released: findItalianAudio(raw || {}), raw };
  } catch {
    return { ok: true, released: false, raw: null };
  }
}

// ============ CACHE (riduce chiamate ripetute alla Streaming API) ============
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 giorni
const releaseCache = new Map(); // tmdbId -> { releaseText, decidedBy, ts } (solo in-memory, ok se si perde)
const memFullCache = new Map(); // id grezzo -> { json, ts } (livello 1, veloce, si perde ai riavvii)

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Cache di risposta completa, con backend persistente (Upstash) se configurato,
// altrimenti solo in-memory (si perde ai riavvii, ma funziona comunque senza setup).
async function cacheGetFull(key) {
  const e = memFullCache.get(key);
  if (e && (Date.now() - e.ts) < CACHE_TTL_MS) return e.json;
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent('full:' + key)}`, { headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN } });
      if (r.ok) {
        const d = await r.json();
        if (d.result) {
          const json = JSON.parse(d.result);
          memFullCache.set(key, { json, ts: Date.now() });
          return json;
        }
      }
    } catch {}
  }
  return null;
}

async function upstashRawGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return { configured: false, present: false };
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent('full:' + key)}`, { headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN } });
    if (!r.ok) return { configured: true, present: false, http_error: r.status };
    const d = await r.json();
    return { configured: true, present: !!d.result };
  } catch (e) {
    return { configured: true, present: false, error: e.message };
  }
}
async function cacheSetFull(key, json) {
  memFullCache.set(key, { json, ts: Date.now() });
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SET', 'full:' + key, JSON.stringify(json), 'EX', Math.floor(CACHE_TTL_MS / 1000)])
      });
    } catch {}
  }
}

// ============ META ============
app.get('/meta/movie/:id.json', async (req, res) => {
  try {
    // Cache "veloce": se conosciamo già la risposta completa per QUESTO id, la ritorniamo
    // subito senza toccare TMDB/Wikidata/Streaming API (velocità massima sui film già aperti).
    const fast = await cacheGetFull(req.params.id);
    if (!req.query.debug && fast) {
      return res.json(fast);
    }

    const tmdbId = await resolveTmdbId(req.params.id);
    if (!tmdbId) return res.status(404).json({ meta: null, error: 'ID non risolvibile' });
    const m = await tmdb('/movie/' + tmdbId);
    if (!m) return res.status(404).json({ meta: null, error: 'Movie not found' });

    if (Object.prototype.hasOwnProperty.call(OVERRIDES, tmdbId)) {
      const releaseText = OVERRIDES[tmdbId] ? '🇮🇹 USCITO IN ITALIA (doppiato)' : '🚫 NON USCITO IN ITALIA';
      const resp = { meta: buildMeta(req.params.id, tmdbId, m, releaseText) };
      await cacheSetFull(req.params.id, resp);
      return res.json(resp);
    }

    const cached = releaseCache.get(tmdbId);
    let releaseText, cacheHit = false, quotaExhausted = false;
    let dTmdb = { status: 'fulfilled', value: undefined }, dWiki = { status: 'fulfilled', value: undefined }, dStream = { status: 'fulfilled', value: undefined };
    let streamRaw = null; // dati grezzi SOLO se la Streaming API viene chiamata in questa richiesta

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
        streamRaw = s.raw;
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
    if (!quotaExhausted) await cacheSetFull(req.params.id, { meta });

    if (req.query.debug) {
      const upstashCheck = await upstashRawGet(req.params.id); // test diretto, bypassa la cache in RAM
      const sources = {
        tmdb_theatrical_tv: dTmdb.status === 'fulfilled' ? dTmdb.value : 'error: ' + dTmdb.reason,
        wikidata: dWiki.status === 'fulfilled' ? dWiki.value : 'error: ' + dWiki.reason,
        streaming_audio_it: dStream.status === 'fulfilled' ? dStream.value : 'error: ' + dStream.reason,
        quota_exhausted: quotaExhausted,
        decided_by: cached ? (cached.decidedBy || 'cache (versione precedente)') : undefined
      };
      return res.json({
        meta, cache_hit: cacheHit, debug: sources,
        streaming_api_called: streamRaw !== null || dStream.value !== undefined, streaming_raw_it: streamRaw,
        upstash: upstashCheck
      });
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
    description: m?.overview || undefined,
    releaseInfo: releaseText,
    imdb_id: m?.imdb_id || undefined
  };
}

app.listen(PORT, () => console.log('Italy Release Checker 3.10 listening on ' + PORT));
