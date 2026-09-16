# 🇮🇹 Italy Release Checker — Nuvio

Addon Stremio/Nuvio che usa TMDB per controllare le release date italiane dei film.

## Funzioni
- 🇮🇹 Cerca un film e mostra la prima release registrata da TMDB per l'Italia.
- 🇮🇹 Catalogo dei film senza una release `IT` registrata su TMDB.
- Metadata con `🇮🇹 USCITA ITALIA: data — tipo` inserito all'inizio della descrizione.
- Link diretto alla pagina TMDB delle release del film.
- Cache temporanea per ridurre le richieste ripetute a TMDB.

## Avvio
Richiede Node.js 18+.

```bash
npm install
npm start
```

Imposta la variabile d'ambiente `TMDB_API_KEY`.

## Installazione Nuvio
Pubblica il server su HTTPS e aggiungi:

`https://TUO-DOMINIO/manifest.json`

## Nota importante
“Non uscita in Italia” significa che TMDB non restituisce una release `IT` per quel film. Non è una prova assoluta che il film non sia mai stato distribuito in Italia.

La data mostrata è la prima data italiana registrata da TMDB tra le release disponibili; il tipo viene indicato come Premiere, Cinema limitato, Cinema, Digitale, Home video o TV.
