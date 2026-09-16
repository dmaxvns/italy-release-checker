const express = require('express');
const https = require('https');
const zlib = require('zlib');
const readline = require('readline');
const app = express();
const PORT = process.env.PORT || 3000;
const KEY = process.env.TMDB_API_KEY;

// --- OVERRIDE MANUALI (rete di sicurezza, ora dovrebbe servire raramente) ---
const OVERRIDES = {};

const MANIFEST = {
  id: 'com.italyreleasechecker.nuvio',
  version: '2.0.0',
  name: '🇮🇹 Italy Release Checker',
  description: 'Controlla se un film risulta uscito in Italia (dataset ufficiale IMDb + TMDB + Wikidata).',
  resources: [
    { name: 'meta', types: ['movie'], idPrefixes: ['tmdb:', 'tt'] }
  ],
  types: ['movie'],
  idPrefixes: ['tmdb:', 'tt']
  // Nessun "catalogs": l'addon non compare in Scopri/ricerca, agisce solo sul meta.
};

app.get('/', (q, r) => r.json({ name: MANIFEST.name, version: MANIFEST.version, status: 'ok' }));
app.get('/manifest.json', (q, r) => r.json(MANIFEST));

// ============ INDICE IMDb (title.akas.tsv.gz, region=IT) ============
// Fonte: https://datasets.imdbws.com/ - dataset ufficiale non-commerciale IMDb, aggiornato ogni giorno.
// Teniamo solo gli ID (numero dopo "tt") dei film con una riga region=IT e un tipo che indica
// un'uscita/localizzazione reale (imdbDisplay = titolo ufficiale per quel mercato, festival, tv, video, dvd).
let itIndex = new Uint32Array(0);
let itIndexBuiltAt = null;
let itIndexBuilding = false;
const STRONG_TYPES = ['imdbDisplay', 'festival', 'tv', 'video', 'dvd'];

function buildItIndex() {
  if (itIndexBuilding) return;
  itIndexBuilding = true;
  const ids = [];
  https.get('https://datasets.imdbws.com/title.akas.tsv.gz', res => {
    if (res.statusCode !== 200) {
      console.error('IT index: HTTP ' + res.statusCode);
      itIndexBuilding = false;
      return;
    }
    const gunzip = zlib.createGunzip();
    res.pipe(gunzip);
    const rl = readline.createInterface({ input: gunzip });
    let first = true;
    rl.on('line', line => {
      if (first) { first = false; return; }
      const tab1 = line.indexOf('\t');
      if (tab1 === -1) return;
      const titleId = line.slice(0, tab1);
      if (titleId.charCodeAt(0) !== 116) return; // fast skip: deve iniziare con "tt"
      const parts = line.split('\t');
      const region = parts[3];
      if (region !== 'IT') return;
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
app.get('/status', (q, r) => r.json({ it_index_titles: itIndex.length, built_at: itIndexBuiltAt, building: itIndexBuilding }));

// ============ Fonti secondarie (colmano i buchi finché l'indice non è pronto o è incompleto) ============
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

async function tmdbIT(id) {
  const d = await tmdb('/movie/' + id + '/release_dates');
  const it = (d?.results || []).find(x => x.iso_3166_1 === 'IT');
  return !!it?.release_dates?.some(x => x.release_date && [1, 2, 3, 4, 5, 6].includes(x.type));
}

async function wikidataIT(id) {
  const m = await tmdb('/movie/' + id);
  if (!m?.imdb_id) return false;
  try {
    const q = `SELECT ?place WHERE {?item wdt:P345 "${m.imdb_id}". ?item p:P577 ?st. ?st pq:P291 ?place.} LIMIT 50`;
    const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), {
      headers: { accept: 'application/sparql-results+json', 'user-agent': 'ItalyReleaseChecker/2.0' }
    });
    if (!r.ok) return false;
    for (const x of (await r.json()).results?.bindings || []) {
      const p = x.place?.value?.split('/').pop();
      if (p === 'Q38') return true;
      if (/^Q\d+$/.test(p)) {
        const q2 = `ASK { wd:${p} (wdt:P17|wdt:P131)* wd:Q38 }`;
        const rr = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q2), {
          headers: { accept: 'application/sparql-results+json', 'user-agent': 'ItalyReleaseChecker/2.0' }
        });
        if (rr.ok && (await rr.json()).boolean) return true;
      }
    }
  } catch {}
  return false;
}

async function providersIT(id) {
  const d = await tmdb('/movie/' + id + '/watch/providers');
  const it = d?.results?.IT;
  if (!it) return false;
  return !!(it.flatrate?.length || it.rent?.length || it.buy?.length);
}

// ============ META ============
app.get('/meta/movie/:id.json', async (req, res) => {
  try {
    const tmdbId = await resolveTmdbId(req.params.id);
    if (!tmdbId) return res.status(404).json({ meta: null, error: 'ID non risolvibile' });
    const m = await tmdb('/movie/' + tmdbId);
    if (!m) return res.status(404).json({ meta: null, error: 'Movie not found' });

    if (Object.prototype.hasOwnProperty.call(OVERRIDES, tmdbId)) {
      const releaseText = OVERRIDES[tmdbId] ? '🇮🇹 USCITO IN ITALIA' : '🚫 NON USCITO IN ITALIA';
      return res.json({ meta: buildMeta(req.params.id, tmdbId, m, releaseText) });
    }

    const [a, b, c] = await Promise.allSettled([tmdbIT(tmdbId), wikidataIT(tmdbId), providersIT(tmdbId)]);
    const sources = {
      imdb_akas_it: { status: 'fulfilled', value: imdbAkaIT(m.imdb_id) },
      tmdb_release_dates: a, wikidata: b, tmdb_watch_providers: c
    };
    const released = Object.values(sources).some(x => x.status === 'fulfilled' && x.value === true);
    const releaseText = released ? '🇮🇹 USCITO IN ITALIA' : '🚫 NON USCITO IN ITALIA';
    const meta = buildMeta(req.params.id, tmdbId, m, releaseText);

    if (req.query.debug) {
      return res.json({
        meta,
        debug: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.status === 'fulfilled' ? v.value : 'error: ' + v.reason])),
        it_index_ready: itIndex.length > 0
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
    description: `${releaseText}${m?.overview ? '\n\n' + m.overview : ''}`,
    releaseInfo: releaseText,
    imdb_id: m?.imdb_id || undefined
  };
}

app.listen(PORT, () => console.log('Italy Release Checker 2.0 listening on ' + PORT));
