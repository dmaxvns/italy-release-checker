# 🇮🇹 Italy Release Checker v1.4

Nuvio/Stremio metadata addon that checks whether a movie has an Italian release.

## Logic
- TMDB: checks the Italian (`IT`) release list, including Digital, Theatrical, Physical, TV and Premiere entries.
- Wikidata: independently checks publication-date statements whose place of publication is Italy or a place in Italy.
- If either source finds an Italian release: `🇮🇹 USCITO IN ITALIA`.
- Otherwise: `🚫 NON USCITO IN ITALIA`.
- The UI intentionally exposes only those two statuses.

## Nuvio search behavior
The searchable `italy-release-check` catalog from v1.3 has been removed. This prevents the addon from being queried/displayed as a result of Nuvio's normal global search.

## Deploy
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Environment variable: `TMDB_API_KEY`
- Keep the same Render service and repository as the working v1.3 deployment.
- After deployment, the existing addon URL/manifest remains the same because the addon id is unchanged.
