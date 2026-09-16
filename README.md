# 🇮🇹 Italy Release Checker — Nuvio

Addon Stremio/Nuvio che usa TMDB per controllare le release date italiane dei film.

## Funzioni
- Catalogo 🇮🇹 Non usciti in Italia
- Ricerca di un film
- Metadata con data italiana e tipo di release
- Usa i dati `release_dates` di TMDB per il paese `IT`

## Avvio
Richiede Node.js 18+.

`npm install`

Imposta `TMDB_API_KEY` e poi:

`npm start`

Manifest locale: `http://localhost:3000/manifest.json`

## Installazione Nuvio
Il server deve essere pubblicato su HTTPS. Poi aggiungi:

`https://TUO-DOMINIO/manifest.json`

## Nota
“Non uscito in Italia” significa che TMDB non restituisce una release `IT`; non è una prova assoluta che non sia mai stato distribuito in Italia. Il catalogo attuale analizza 20 candidati per pagina e va potenziato con cache/database per una copertura completa.
