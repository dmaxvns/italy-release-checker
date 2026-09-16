import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;
const KEY = process.env.TMDB_API_KEY;
const TMDB = 'https://api.themoviedb.org/3';
const WIKIDATA = 'https://query.wikidata.org/sparql';
const IMG = 'https://image.tmdb.org/t/p/w500';
const BG = 'https://image.tmdb.org/t/p/w1280';
const cache = new Map();
const CACHE_MS = 12 * 60 * 60 * 1000;

async function cachedFetch(url, options = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.data;
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  cache.set(url, { time: Date.now(), data });
  return data;
}

async function tmdb(path, params = {}) {
  if (!KEY) throw new Error('TMDB_API_KEY missing');
  const url = new URL(TMDB + path);
  url.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  return cachedFetch(url.toString());
}

function italyReleases(data) {
  const country = data?.results?.find(x => x.iso_3166_1 === 'IT');
  return (country?.release_dates || []).filter(x => x.release_date);
}

// TMDB counts every Italian release type: premiere, theatrical, digital, physical and TV.
function tmdbSaysItaly(releaseData) {
  return italyReleases(releaseData).length > 0;
}

function wikidataQuery(imdbId) {
  const query = `
SELECT DISTINCT ?date ?place WHERE {
  ?item wdt:P345 "${imdbId}".
  ?item p:P577 ?statement.
  ?statement ps:P577 ?date.
  ?statement pq:P291 ?place.
  {
    VALUES ?place { wd:Q38 }
  }
  UNION
  {
    ?place wdt:P17 wd:Q38.
  }
  UNION
  {
    ?place wdt:P131* wd:Q38.
  }
}`;
  const url = new URL(WIKIDATA);
  url.searchParams.set('query', query);
  url.searchParams.set('format', 'json');
  return url.toString();
}

async function wikidataSaysItaly(imdbId) {
  if (!imdbId || !/^tt\d+$/.test(imdbId)) return false;
  try {
    const data = await cachedFetch(wikidataQuery(imdbId), {
      headers: {
        'Accept': 'application/sparql-results+json',
        'User-Agent': 'ItalyReleaseChecker/1.4 (Nuvio addon)'
      }
    });
    return Array.isArray(data?.results?.bindings) && data.results.bindings.length > 0;
  } catch {
    return false;
  }
}

async function resolveMovieId(rawId) {
  const id = String(rawId || '');
  if (/^tmdb:\d+$/.test(id)) return id.slice(5);
  if (/^\d+$/.test(id)) return id;
  if (/^tt\d+$/.test(id)) {
    const found = await tmdb(`/find/${id}`, { external_source: 'imdb_id' });
    return found?.movie_results?.[0]?.id ? String(found.movie_results[0].id) : null;
  }
  return null;
}

function statusText(released) {
  return released ? '🇮🇹 USCITO IN ITALIA' : '🚫 NON USCITO IN ITALIA';
}

function buildMeta(movie, released) {
  const status = statusText(released);
  const overview = movie.overview || '';
  const meta = {
    id: `tmdb:${movie.id}`,
    type: 'movie',
    name: movie.title || movie.original_title,
    poster: movie.poster_path ? IMG + movie.poster_path : undefined,
    background: movie.backdrop_path ? BG + movie.backdrop_path : undefined,
    description: `${status}${overview ? `\n\n${overview}` : ''}`,
    releaseInfo: status,
    releaseDate: movie.release_date || undefined,
    year: movie.release_date ? Number(movie.release_date.slice(0, 4)) : undefined,
    imdb_id: movie.imdb_id || undefined,
    runtime: movie.runtime || undefined,
    genres: Array.isArray(movie.genres) ? movie.genres.map(g => g.name) : undefined,
    links: [{ name: status, category: 'release-info', url: `https://www.themoviedb.org/movie/${movie.id}/release-dates` }]
  };
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
}

async function getMovieMeta(rawId) {
  const id = await resolveMovieId(rawId);
  if (!id) throw new Error('ID film non riconosciuto');

  const [movie, releaseData] = await Promise.all([
    tmdb(`/movie/${id}`, { language: 'it-IT' }),
    tmdb(`/movie/${id}/release_dates`)
  ]);

  let imdbId = movie.imdb_id;
  if (!imdbId) {
    try {
      const ext = await tmdb(`/movie/${id}/external_ids`);
      imdbId = ext?.imdb_id || null;
    } catch {}
  }

  const tmdbYes = tmdbSaysItaly(releaseData);
  const wikidataYes = await wikidataSaysItaly(imdbId);
  const released = tmdbYes || wikidataYes;

  return buildMeta(movie, released);
}

app.get('/manifest.json', (req, res) => res.json({
  id: 'com.italyreleasechecker.nuvio',
  version: '1.4.0',
  name: '🇮🇹 Italy Release Checker',
  description: 'Verifica la presenza di una release italiana tramite TMDB e Wikidata.',
  resources: [
    { name: 'meta', types: ['movie'], idPrefixes: ['tmdb:', 'tt'] },
    { name: 'catalog', types: ['movie'] }
  ],
  types: ['movie'],
  idPrefixes: ['tmdb:', 'tt'],
  // Deliberately NO search catalog: it must not appear in Nuvio global search.
  catalogs: [
    { type: 'movie', id: 'no-italy-release', name: '🇮🇹 Non usciti in Italia', extra: [{ name: 'skip', isRequired: false }] }
  ]
}));

app.get('/meta/movie/:id.json', async (req, res) => {
  try { res.json({ meta: await getMovieMeta(req.params.id) }); }
  catch (e) { res.status(404).json({ meta: null, error: e.message }); }
});

app.get('/catalog/movie/no-italy-release.json', async (req, res) => {
  try {
    const skip = Math.max(0, Number(req.query.skip || 0));
    const page = Math.max(1, Math.min(Math.floor(skip / 20) + 1, 500));
    const data = await tmdb('/discover/movie', {
      language: 'it-IT',
      sort_by: 'popularity.desc',
      page,
      include_adult: 'false'
    });
    const metas = [];
    for (const movie of (data.results || []).slice(0, 20)) {
      try {
        const full = await tmdb(`/movie/${movie.id}`, { language: 'it-IT' });
        const releases = await tmdb(`/movie/${movie.id}/release_dates`);
        let imdbId = full.imdb_id;
        if (!imdbId) {
          try {
            const ext = await tmdb(`/movie/${movie.id}/external_ids`);
            imdbId = ext?.imdb_id || null;
          } catch {}
        }
        const released = tmdbSaysItaly(releases) || await wikidataSaysItaly(imdbId);
        if (!released) metas.push(buildMeta(full, false));
      } catch {}
    }
    res.json({ metas });
  } catch (e) {
    res.status(500).json({ metas: [], error: e.message });
  }
});

app.get('/', (req, res) => res.type('text').send(
  `Italy Release Checker v1.4.0\nManifest: /manifest.json\nTMDB key: ${KEY ? 'configured' : 'missing'}`
));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
