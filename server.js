const express = require('express');
const cheerio = require('cheerio');
const app = express();
const PORT = process.env.PORT || 3000;
const KEY = process.env.TMDB_API_KEY;

const MANIFEST = {
  id: 'com.italyreleasechecker.nuvio',
  version: '1.7.0',
  name: '🇮🇹 Italy Release Checker',
  description: 'Controlla se un film risulta uscito in Italia (TMDB + IMDb + Wikidata + JustWatch).',
  resources: [
    { name: 'meta', types: ['movie'], idPrefixes: ['tmdb:', 'tt'] },
    { name: 'catalog', types: ['movie'] }
  ],
  types: ['movie'],
  idPrefixes: ['tmdb:', 'tt'],
  catalogs: [{
    type: 'movie',
    id: 'italy-release-check',
    name: '🇮🇹 Italy Release Checker',
    extra: [{ name: 'search', isRequired: false }]
  }]
};

app.get('/', (q, r) => r.json({ name: MANIFEST.name, version: MANIFEST.version, status: 'ok' }));
app.get('/manifest.json', (q, r) => r.json(MANIFEST));

async function tmdb(path) {
  if (!KEY) return null;
  const u = new URL('https://api.themoviedb.org/3' + path);
  u.searchParams.set('api_key', KEY);
  u.searchParams.set('language', 'it-IT');
  const r = await fetch(u);
  return r.ok ? r.json() : null;
}

// Risolve tmdb:123 / 123 / tt1234567 -> id TMDB numerico
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

async function imdbIT(imdb) {
  if (!imdb) return false;
  try {
    const r = await fetch('https://www.imdb.com/title/' + imdb + '/releaseinfo/', {
      headers: { accept: 'text/html', 'accept-language': 'it-IT,it;q=0.9', 'user-agent': 'Mozilla/5.0' }
    });
    if (!r.ok) return false;
    const $ = cheerio.load(await r.text());
    const t = $('body').text().replace(/\s+/g, ' ');
    return /\bItaly\b/i.test(t) || /\bItalia\b/i.test(t);
  } catch { return false; }
}

async function wikidataIT(id) {
  const m = await tmdb('/movie/' + id);
  if (!m) return false;
  const imdb = m.imdb_id;
  if (!imdb) return false;
  try {
    const q = `SELECT ?place WHERE {?item wdt:P345 "${imdb}". ?item p:P577 ?st. ?st pq:P291 ?place.} LIMIT 50`;
    const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), {
      headers: { accept: 'application/sparql-results+json', 'user-agent': 'ItalyReleaseChecker/1.7' }
    });
    if (!r.ok) return false;
    for (const x of (await r.json()).results?.bindings || []) {
      const p = x.place?.value?.split('/').pop();
      if (p === 'Q38') return true;
      if (/^Q\d+$/.test(p)) {
        const q2 = `ASK { wd:${p} (wdt:P17|wdt:P131)* wd:Q38 }`;
        const rr = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q2), {
          headers: { accept: 'application/sparql-results+json', 'user-agent': 'ItalyReleaseChecker/1.7' }
        });
        if (rr.ok && (await rr.json()).boolean) return true;
      }
    }
  } catch {}
  return false;
}

async function justwatch(title) {
  if (!title) return false;
  try {
    const r = await fetch('https://www.justwatch.com/it/ricerca?q=' + encodeURIComponent(title), {
      headers: { accept: 'text/html', 'accept-language': 'it-IT,it;q=0.9', 'user-agent': 'Mozilla/5.0' }
    });
    if (!r.ok) return false;
    const $ = cheerio.load(await r.text());
    const n = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const w = n(title);
    let ok = false;
    $('a').each((_, e) => { const t = n($(e).text()); if (t && t === w) ok = true; });
    return ok;
  } catch { return false; }
}

// --- META: chiamato da Nuvio per QUALSIASI film (tmdb: o tt...), grazie a idPrefixes ---
app.get('/meta/movie/:id.json', async (req, res) => {
  try {
    const tmdbId = await resolveTmdbId(req.params.id);
    if (!tmdbId) return res.status(404).json({ meta: null, error: 'ID non risolvibile' });
    const m = await tmdb('/movie/' + tmdbId);
    if (!m) return res.status(404).json({ meta: null, error: 'Movie not found' });

    const [a, b, c, d] = await Promise.allSettled([
      tmdbIT(tmdbId), imdbIT(m.imdb_id), wikidataIT(tmdbId), justwatch(m.title || m.original_title)
    ]);
    const released = [a, b, c, d].some(x => x.status === 'fulfilled' && x.value === true);
    const releaseText = released ? '🇮🇹 USCITO IN ITALIA' : '🚫 NON USCITO IN ITALIA';

    res.json({
      meta: {
        id: req.params.id.startsWith('tt') ? req.params.id : 'tmdb:' + tmdbId,
        type: 'movie',
        name: m.title || m.original_title,
        poster: m.poster_path ? 'https://image.tmdb.org/t/p/w500' + m.poster_path : undefined,
        background: m.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + m.backdrop_path : undefined,
        description: `${releaseText}${m.overview ? '\n\n' + m.overview : ''}`,
        releaseInfo: releaseText,
        imdb_id: m.imdb_id || undefined
      }
    });
  } catch (e) {
    res.status(500).json({ meta: null, error: 'Release check failed' });
  }
});

// --- CATALOG: browse/ricerca dentro l'addon (facoltativo, comodo per test) ---
app.get('/catalog/movie/italy-release-check.json', async (req, res) => {
  try {
    const search = req.query.search;
    const data = search
      ? await tmdb('/search/movie?query=' + encodeURIComponent(search))
      : await tmdb('/movie/popular');
    const metas = (data?.results || []).slice(0, 20).map(m => ({
      id: 'tmdb:' + m.id,
      type: 'movie',
      name: m.title || m.original_title,
      poster: m.poster_path ? 'https://image.tmdb.org/t/p/w500' + m.poster_path : undefined
    }));
    res.json({ metas });
  } catch (e) {
    res.json({ metas: [] });
  }
});

app.listen(PORT, () => console.log('Italy Release Checker 1.7 listening on ' + PORT));
