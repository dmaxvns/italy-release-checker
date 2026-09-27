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
  version: '3.22.0',
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

// Chiamato periodicamente da un GitHub Action esterno: fa un comando Redis vero su Upstash
// per resettare il contatore dei 14 giorni di inattività ed evitare l'archiviazione automatica.
app.get('/keepalive', async (req, res) => {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return res.json({ upstash_configured: false });
  try {
    await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', 'keepalive', new Date().toISOString()])
    });
    res.json({ ok: true, pinged_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Esporta tutta la cache Upstash (tutti i film salvati) in un unico JSON, per il backup settimanale.
async function upstashCmd(cmd) {
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await r.json()).result;
}

app.get('/backup', async (req, res) => {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return res.status(400).json({ error: 'Upstash non configurato' });
  try {
    let cursor = '0', keys = [];
    do {
      const [next, batch] = await upstashCmd(['SCAN', cursor, 'MATCH', 'full:*', 'COUNT', 200]);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');

    const films = {};
    const CHUNK = 100;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      const values = await upstashCmd(['MGET', ...chunk]);
      chunk.forEach((k, idx) => { films[k] = values[idx] ? JSON.parse(values[idx]) : null; });
    }
    res.json({ generated_at: new Date().toISOString(), count: keys.length, films });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
const CACHE_TTL_NEGATIVE_MS = 30 * 24 * 60 * 60 * 1000; // 30 giorni, solo per i verdetti "non uscito"
const isPositiveVerdict = (releaseText) => !!releaseText && releaseText.startsWith('🇮🇹');
// Durata da usare per un dato verdetto: per sempre se "uscito", 30 giorni altrimenti.
const ttlFor = (releaseText) => isPositiveVerdict(releaseText) ? Infinity : CACHE_TTL_NEGATIVE_MS;
const releaseCache = new Map(); // tmdbId -> { releaseText, decidedBy, ts } (solo in-memory, ok se si perde)
const memFullCache = new Map(); // id grezzo -> { json, ts } (livello 1, veloce, si perde ai riavvii)

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Cache di risposta completa, con backend persistente (Upstash) se configurato,
// altrimenti solo in-memory (si perde ai riavvii, ma funziona comunque senza setup).
async function cacheGetFull(key) {
  const e = memFullCache.get(key);
  if (e && (Date.now() - e.ts) < ttlFor(e.json?.meta?.releaseInfo)) return e.json;
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
      const ttlSeconds = ttlFor(json?.meta?.releaseInfo);
      const cmd = ttlSeconds === Infinity
        ? ['SET', 'full:' + key, JSON.stringify(json)] // nessuna scadenza: resta per sempre
        : ['SET', 'full:' + key, JSON.stringify(json), 'EX', Math.floor(ttlSeconds / 1000)];
      await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd)
      });
    } catch {}
  }
}

// Esegue tutto il controllo (cache film, TMDB, Wikidata, eventualmente Streaming API)
// e restituisce sempre lo stesso identico risultato di prima — usata sia dal percorso
// debug (senza limiti di tempo) sia dal percorso veloce (con timeout, vedi sotto).
async function computeVerdict(tmdbId, m, preStartedTmdbCheck) {
  const cached = releaseCache.get(tmdbId);
  if (cached && (Date.now() - cached.ts) < ttlFor(cached.releaseText)) {
    return {
      releaseText: cached.releaseText, cacheHit: true, quotaExhausted: false, decidedBy: cached.decidedBy,
      dTmdb: { status: 'fulfilled', value: undefined }, dWiki: { status: 'fulfilled', value: undefined },
      dStream: { status: 'fulfilled', value: undefined }, streamRaw: null
    };
  }
  const [dTmdb, dWiki] = await Promise.allSettled([preStartedTmdbCheck || tmdbTheatricalTvIT(tmdbId), wikidataIT(m.imdb_id)]);
  let released = (dTmdb.status === 'fulfilled' && dTmdb.value) || (dWiki.status === 'fulfilled' && dWiki.value);
  let decidedBy = dTmdb.status === 'fulfilled' && dTmdb.value ? 'tmdb_theatrical_tv'
    : (dWiki.status === 'fulfilled' && dWiki.value ? 'wikidata' : null);
  let dStream = { status: 'fulfilled', value: undefined }, streamRaw = null, quotaExhausted = false;
  if (!released) {
    const s = await streamingAudioIT(tmdbId);
    dStream = { status: 'fulfilled', value: s.released };
    streamRaw = s.raw;
    quotaExhausted = !s.ok;
    released = s.released;
    decidedBy = released ? 'streaming_audio_it' : (quotaExhausted ? 'quota_esaurita' : 'nessuna_fonte');
  }
  const releaseText = quotaExhausted && !released
    ? '⚠️ NON VERIFICABILE (quota API mensile esaurita)'
    : (released ? '🇮🇹 USCITO IN ITALIA (doppiato)' : '🚫 NON USCITO IN ITALIA');
  if (!quotaExhausted) releaseCache.set(tmdbId, { releaseText, decidedBy, ts: Date.now() });
  return { releaseText, cacheHit: false, quotaExhausted, decidedBy, dTmdb, dWiki, dStream, streamRaw };
}

const inFlightVerdicts = new Map(); // tmdbId -> Promise, condiviso tra richieste ravvicinate sullo stesso film
function getOrStartVerdict(tmdbId, m, tmdbCheckPromise, rawId) {
  if (inFlightVerdicts.has(tmdbId)) return inFlightVerdicts.get(tmdbId);
  const p = computeVerdict(tmdbId, m, tmdbCheckPromise).then(async (v) => {
    if (!v.quotaExhausted) await cacheSetFull(rawId, { meta: buildMeta(rawId, tmdbId, m, v.releaseText) });
    return v;
  }).catch(() => null).finally(() => inFlightVerdicts.delete(tmdbId));
  inFlightVerdicts.set(tmdbId, p);
  return p;
}

// ============ META ============
app.get('/meta/movie/:id.json', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    // Cache "veloce": se conosciamo già la risposta completa per QUESTO id, la ritorniamo
    // subito senza toccare TMDB/Wikidata/Streaming API (velocità massima sui film già aperti).
    const fast = await cacheGetFull(req.params.id);
    if (!req.query.debug && fast) {
      return res.json(fast);
    }

    const tmdbId = await resolveTmdbId(req.params.id);
    if (!tmdbId) return res.status(404).json({ meta: null, error: 'ID non risolvibile' });
    const tmdbCheckPromise = tmdbTheatricalTvIT(tmdbId).catch(() => false); // parte già ora, non aspetta i dettagli del film
    const m = await tmdb('/movie/' + tmdbId);
    if (!m) return res.status(404).json({ meta: null, error: 'Movie not found' });

    if (Object.prototype.hasOwnProperty.call(OVERRIDES, tmdbId)) {
      const releaseText = OVERRIDES[tmdbId] ? '🇮🇹 USCITO IN ITALIA (doppiato)' : '🚫 NON USCITO IN ITALIA';
      const resp = { meta: buildMeta(req.params.id, tmdbId, m, releaseText) };
      await cacheSetFull(req.params.id, resp);
      return res.json(resp);
    }

    if (req.query.debug) {
      // Percorso debug: sempre calcolo completo, senza limiti di tempo.
      const v = await computeVerdict(tmdbId, m, tmdbCheckPromise);
      const meta = buildMeta(req.params.id, tmdbId, m, v.releaseText);
      if (!v.quotaExhausted) await cacheSetFull(req.params.id, { meta });
      const upstashCheck = await upstashRawGet(req.params.id);
      const sources = {
        tmdb_theatrical_tv: v.dTmdb.status === 'fulfilled' ? v.dTmdb.value : 'error: ' + v.dTmdb.reason,
        wikidata: v.dWiki.status === 'fulfilled' ? v.dWiki.value : 'error: ' + v.dWiki.reason,
        streaming_audio_it: v.dStream.status === 'fulfilled' ? v.dStream.value : 'error: ' + v.dStream.reason,
        quota_exhausted: v.quotaExhausted,
        decided_by: v.decidedBy
      };
      return res.json({
        meta, cache_hit: v.cacheHit, debug: sources,
        streaming_api_called: v.streamRaw !== null || v.dStream.value !== undefined, streaming_raw_it: v.streamRaw,
        upstash: upstashCheck
      });
    }

    // Risposta entro TIMEOUT_MS: trama/poster sempre pronti subito, badge quando il controllo
    // fa in tempo (altrimenti arriva al giro successivo, già in cache). Se riapri lo stesso film
    // mentre il controllo precedente è ancora in corso, condividiamo quello — non ripartiamo da zero.
    const TIMEOUT_MS = 500;
    const TIMEOUT_SENTINEL = Symbol('timeout');
    const verdictPromise = getOrStartVerdict(tmdbId, m, tmdbCheckPromise, req.params.id);

    const raced = await Promise.race([
      verdictPromise,
      new Promise(resolve => setTimeout(() => resolve(TIMEOUT_SENTINEL), TIMEOUT_MS))
    ]);

    if (raced === TIMEOUT_SENTINEL || !raced) {
      return res.json({ meta: buildMeta(req.params.id, tmdbId, m, undefined) });
    }
    return res.json({ meta: buildMeta(req.params.id, tmdbId, m, raced.releaseText) });
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
    description: releaseText ? `${releaseText}${m?.overview ? '\n\n' + m.overview : ''}` : (m?.overview || undefined),
    releaseInfo: releaseText || undefined,
    imdb_id: m?.imdb_id || undefined
  };
}

app.listen(PORT, () => console.log('Italy Release Checker 3.22 listening on ' + PORT));
