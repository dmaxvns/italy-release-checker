# 🇮🇹 Italy Release Checker v1.3.0

Metadata addon compatibile con Nuvio/Stremio. Per i film aggiunge in cima alla descrizione la prima uscita italiana registrata su TMDB, con data e tipo di release.

Esempio:
`🇮🇹 USCITA ITALIA: 15/09/2026 — Cinema`

Se TMDB non contiene una release italiana:
`🚫 NESSUNA USCITA ITALIANA REGISTRATA SU TMDB`

## Installazione

1. Impostare `TMDB_API_KEY` su Render.
2. Deployare il servizio.
3. Installare in Nuvio il manifest URL del servizio:
   `/manifest.json`

La v1.3 dichiara esplicitamente il supporto metadata per ID `tmdb:` e IMDb `tt...`, così Nuvio può interrogarla quando apre un film proveniente da altri cataloghi.
