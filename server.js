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
  return ({
    1: 'Premiere',
    2: 'Cinema limitato',
    3: 'Cinema',
    4: 'Digitale',
    5: 'Home video',
    6: 'TV'
  })[type] || 'Altro';
}

function formatDate(value) {
  if (!value) return null;
  const [year, month, day] = value.slice(0, 10).split('-');
  if (!year || !month || !day) return value.slice(0, 10);
  return `${day}/${month}/${year}`;
}

function italyReleases(data) {
  const country = data?.results?.find(x => x.iso_3166_1 === 'IT');
  if (!country?.release_dates?.length) return [];
  return country.release_dates
    .filter(x => x.release_date)
    .sort((a, b) => a.release_date.localeCompare(b.release_date));
}

function firstItalyRelease(data) {
  return italyReleases(data)[0] || null;
}

function buildMeta(movie, release) {
  const hasItaly = Boolean(release);
  const releaseText = hasItaly
    ? `🇮🇹 USCITA ITALIA: ${formatDate(release.release_date)} — ${typeLabel(release.type)}`
    : '🚫 NESSUNA USCITA ITALIANA REGISTRATA SU TMDB';

  const overview = movie.overview || '';
  const description = `${releaseText}${overview ? `\n\n${overview}` : ''}`;

  return {
    id: `tmdb:${movie.id}`,
    type: 'movie',
    name: movie.title || movie.original_title,
    poster: movie.poster_path ? IMG + movie.poster_path : undefined,
    background: movie.backdrop_path ? BG + movie.backdrop_path : undefined,
    description,
    releaseInfo: releaseText,
    releaseDate: movie.release_date || undefined,
    links: [
      {
        name: releaseText,
        category: 'release-info',
        url: `https://www.themoviedb.org/movie/${movie.id}/release-dates`
      }
    ]
  };
}

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.italyreleasechecker.nuvio',
    version: '1.2.0',
    name: '🇮🇹 Italy Release Checker',
    description: 'Controlla le date di uscita italiane dei film usando TMDB.',
    resources: ['catalog', 'meta'],
    types: ['movie'],
    catalogs: [
      {
        type: 'movie',
        id: 'no-italy-release',
        name: '🇮🇹 Non usciti in Italia',
        extra: [{ name: 'skip', isRequired: false }]
      },
      {
        type: 'movie',
        id: 'italy-release-check',
        name: '🇮🇹 Cerca release Italia',
        extra: [{ name: 'search', isRequired: false }]
      }
    ]
  });
});

app.get('/catalog/movie/italy-release-check.json', async (req, res) => {
  try {
    const query = String(req.query.search || '').trim();
    if (!query) return res.json({ metas: [] });

    const data = await tmdb('/search/movie', {
      query,
      language: 'it-IT',
      include_adult: 'false'
    });

    const metas = [];
    for (const movie of (data.results || []).slice(0, 10)) {
      try {
        const releases = await tmdb(`/movie/${movie.id}/release_dates`);
        metas.push(buildMeta(movie, firstItalyRelease(releases)));
      } catch {
        // Skip movies for which TMDB release data is unavailable.
      }
    }

    res.json({ metas });
  } catch (error) {
    res.status(500).json({ metas: [], error: error.message });
  }
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
        const releases = await tmdb(`/movie/${movie.id}/release_dates`);
        if (!firstItalyRelease(releases)) metas.push(buildMeta(movie, null));
      } catch {
        // Skip movies for which TMDB release data is unavailable.
      }
    }

    res.json({ metas });
  } catch (error) {
    res.status(500).json({ metas: [], error: error.message });
  }
});

app.get('/meta/movie/:id.json', async (req, res) => {
  try {
    const id = req.params.id.replace(/^tmdb:/, '');
    if (!/^\d+$/.test(id)) {
      return res.status(400).json({ error: 'TMDB ID non valido' });
    }

    const [movie, releaseData] = await Promise.all([
      tmdb(`/movie/${id}`, { language: 'it-IT' }),
      tmdb(`/movie/${id}/release_dates`)
    ]);

    res.json({ meta: buildMeta(movie, firstItalyRelease(releaseData)) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.type('text').send(
    `Italy Release Checker v1.2.0\nManifest: /manifest.json\nTMDB key: ${KEY ? 'configured' : 'missing'}`
  );
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
