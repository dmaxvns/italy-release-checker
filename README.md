# Italy Release Checker v3.15

Addon Stremio/Nuvio (solo risorsa `meta`, nessun catalogo: non compare in Scopri/ricerca).
Arricchisce il meta di qualsiasi film (`tmdb:` o `tt...`) con il verdetto se ha un doppiaggio italiano.

## Fonti (in ordine, basta una vera)
1. Override manuali nel codice (`OVERRIDES`) — pochi casi non tracciati da nessuna fonte pubblica.
2. Cache (30 giorni): in-memory + Upstash Redis persistente, se configurato.
3. TMDB `release_dates` — uscita cinema/anteprima/TV in Italia (esclude digital/fisico).
4. Wikidata — data di pubblicazione con luogo = Italia.
5. Streaming Availability API (RapidAPI, movieofthenight) — traccia audio `ita` reale su una piattaforma IT.

## Environment su Render
- `TMDB_API_KEY` (obbligatoria)
- `STREAMING_API_KEY` (chiave RapidAPI "Streaming Availability API", piano free 1000 richieste/mese)
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (opzionali, cache persistente tra riavvii)

Build `npm install`; Start `npm start`.

## Endpoint utili
- `/status` — stato configurazione (chiavi presenti, cache persistente attiva)
- `/meta/movie/<id>.json?debug=1` — mostra tutte le fonti singolarmente, dati grezzi Streaming API, verifica Upstash

## Nota versione corrente (v3.15)
Contiene un ritardo artificiale di 4s sui film non in cache, **solo a scopo di test** (per capire se
Nuvio abbandona le richieste lente durante lo scroll veloce). Da rimuovere/ripristinare a seconda
dell'esito del test.
