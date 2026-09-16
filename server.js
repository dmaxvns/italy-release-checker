import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;
const KEY = process.env.TMDB_API_KEY;
const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w500';
const BG = 'https://image.tmdb.org/t/p/w1280';
const cache = new Map();
const CACHE_MS = 30 * 60 * 1000;

async function tmdb(path, params = {}) {
  if (!KEY) throw new Error('TMDB_API_KEY missing');
  const url = new URL(BASE + path);
  url.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const cacheKey = url.toString();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.data;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
  const data = await response.json();
  cache.set(cacheKey, { time: Date.now(), data });
  return data;
}

function typeLabel(type) {
  return ({1:'Premiere',2:'Cinema limitato',3:'Cinema',4:'Digitale',5:'Home video',6:'TV'})[type] || 'Altro';
}

function formatDate(value) {
  if (!value) return null;
  const [y,m,d] = value.slice(0,10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : value.slice(0,10);
}

function italyReleases(data) {
  const country = data?.results?.find(x => x.iso_3166_1 === 'IT');
  return (country?.release_dates || [])
    .filter(x => x.release_date)
    .sort((a,b) => a.release_date.localeCompare(b.release_date));
}

function firstItalyRelease(data) { return italyReleases(data)[0] || null; }

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

function buildMeta(movie, release) {
  const releaseText = release
    ? `🇮🇹 USCITA ITALIA: ${formatDate(release.release_date)} — ${typeLabel(release.type)}`
    : '🚫 NESSUNA USCITA ITALIANA REGISTRATA SU TMDB';

  const overview = movie.overview || '';
  const description = `${releaseText}${overview ? `\n\n${overview}` : ''}`;
  const meta = {
    id: `tmdb:${movie.id}`,
    type: 'movie',
    name: movie.title || movie.original_title,
    poster: movie.poster_path ? IMG + movie.poster_path : undefined,
    background: movie.backdrop_path ? BG + movie.backdrop_path : undefined,
    description,
    releaseInfo: releaseText,
    releaseDate: movie.release_date || undefined,
    year: movie.release_date ? Number(movie.release_date.slice(0,4)) : undefined,
    imdb_id: movie.imdb_id || undefined,
    runtime: movie.runtime || undefined,
    genres: Array.isArray(movie.genres) ? movie.genres.map(g => g.name) : undefined,
    links: [{
      name: releaseText,
      category: 'release-info',
      url: `https://www.themoviedb.org/movie/${movie.id}/release-dates`
    }]
  };
  return Object.fromEntries(Object.entries(meta).filter(([,v]) => v !== undefined));
}

async function getMovieMeta(rawId) {
  const id = await resolveMovieId(rawId);
  if (!id) throw new Error('ID film non riconosciuto');
  const [movie, releaseData] = await Promise.all([
    tmdb(`/movie/${id}`, { language: 'it-IT', append_to_response: 'credits' }),
    tmdb(`/movie/${id}/release_dates`)
  ]);
  return buildMeta(movie, firstItalyRelease(releaseData));
}

app.get('/manifest.json', (req,res) => res.json({
  id: 'com.italyreleasechecker.nuvio',
  version: '1.3.0',
  name: '🇮🇹 Italy Release Checker',
  description: 'Metadata addon: aggiunge la data e il tipo di uscita italiana ai film tramite TMDB.',
  resources: [
    { name: 'meta', types: ['movie'], idPrefixes: ['tmdb:', 'tt'] },
    { name: 'catalog', types: ['movie'] }
  ],
  types: ['movie'],
  idPrefixes: ['tmdb:', 'tt'],
  catalogs: [
    { type:'movie', id:'no-italy-release', name:'🇮🇹 Non usciti in Italia', extra:[{name:'skip',isRequired:false}] },
    { type:'movie', id:'italy-release-check', name:'🇮🇹 Cerca release Italia', extra:[{name:'search',isRequired:false}] }
  ]
}));

app.get('/meta/movie/:id.json', async (req,res) => {
  try { res.json({ meta: await getMovieMeta(req.params.id) }); }
  catch (e) { res.status(404).json({ meta: null, error: e.message }); }
});

app.get('/catalog/movie/italy-release-check.json', async (req,res) => {
  try {
    const query = String(req.query.search || '').trim();
    if (!query) return res.json({ metas: [] });
    const data = await tmdb('/search/movie', { query, language:'it-IT', include_adult:'false' });
    const metas = [];
    for (const movie of (data.results || []).slice(0,10)) {
      try {
        const releases = await tmdb(`/movie/${movie.id}/release_dates`);
        metas.push(buildMeta(movie, firstItalyRelease(releases)));
      } catch {}
    }
    res.json({ metas });
  } catch (e) { res.status(500).json({ metas: [], error:e.message }); }
});

app.get('/catalog/movie/no-italy-release.json', async (req,res) => {
  try {
    const skip = Math.max(0, Number(req.query.skip || 0));
    const page = Math.max(1, Math.min(Math.floor(skip/20)+1,500));
    const data = await tmdb('/discover/movie', { language:'it-IT', sort_by:'popularity.desc', page, include_adult:'false' });
    const metas = [];
    for (const movie of (data.results || []).slice(0,20)) {
      try {
        const releases = await tmdb(`/movie/${movie.id}/release_dates`);
        if (!firstItalyRelease(releases)) metas.push(buildMeta(movie,null));
      } catch {}
    }
    res.json({ metas });
  } catch (e) { res.status(500).json({ metas: [], error:e.message }); }
});

app.get('/', (req,res) => res.type('text').send(`Italy Release Checker v1.3.0\nManifest: /manifest.json\nTMDB key: ${KEY ? 'configured' : 'missing'}`));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
