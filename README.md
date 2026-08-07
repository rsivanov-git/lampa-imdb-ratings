# Lampa IMDb Ratings

Small ASP.NET Core 10 + SQLite service plus a Lampa plugin. Lampa sends one batch request for visible cards; the service resolves TMDB -> IMDb only on cache misses and reads current ratings from the official IMDb non-commercial `title.ratings.tsv.gz` dataset.

## 1. Configure tokens
Copy the environment template and edit `.env`:

```bash
cp .env.example .env
```

- `TMDB_TOKEN` is a TMDB API Read Access Token (Bearer token). Without it, only cards that already contain an IMDb ID can be resolved.
- `SERVICE_TOKEN` is required and must be a long random value. Use the same value in Lampa plugin settings.

## 2. Start
```bash
docker compose up -d --build
```

The service listens on `127.0.0.1:8088`, intended to be published via your existing HTTPS reverse proxy.

Readiness check (returns HTTP 503 until ratings have been imported):
```bash
curl http://127.0.0.1:8088/health
```

Liveness check:
```bash
curl http://127.0.0.1:8088/health/live
```

First startup downloads/imports the IMDb ratings dataset. Existing ratings remain available if a future refresh fails.

## Tests

The integration test uses a local one-row IMDb fixture and does not call IMDb or TMDB:

```bash
./tests/integration.sh
```

It requires .NET 10 or newer, Python 3, `curl`, and `gzip`. Set `DOTNET_CMD` for a non-default .NET installation, or set `APP_IMAGE` to test an already-built Docker image.

## Daily refresh
Default: 16:00 UTC every day (`REFRESH_UTC_HOUR=16`). On startup the service also refreshes if the last successful check was more than 20 hours ago.

The GET uses `If-None-Match` / `If-Modified-Since` when available. A `304 Not Modified` only updates the last-check timestamp. A changed dataset is streamed through gzip into `ratings_next`; after a successful import a short SQLite transaction swaps it into place. Old ratings remain active until the swap succeeds. The swap is rejected if the header is invalid, fewer than `MINIMUM_RATING_ROWS` rows are imported, or an update unexpectedly loses more than 10% of the active rows.

## API
POST `/api/ratings`

Header:
```
X-Api-Key: your-service-token
```

Body:
```json
{
  "items": [
    { "type": "movie", "tmdb": 278, "imdb": null },
    { "type": "tv", "tmdb": 1396, "imdb": null }
  ]
}
```

Response:
```json
{
  "items": {
    "movie:278": { "imdb": "tt0111161", "rating": 9.3, "votes": 3100000 },
    "tv:1396": { "imdb": "tt0903747", "rating": 9.5, "votes": 2400000 }
  }
}
```

## Lampa
Host `plugin/imdb-ratings.js` at an HTTPS URL and add that URL under Lampa Extensions. Then set:
- Rating service URL: your HTTPS service URL, no trailing `/api/ratings`
- Service token: same `SERVICE_TOKEN`
- IMDb instead of TMDB: enabled

## Notes
- Successful `TMDB -> IMDb` mappings are permanent in SQLite. Missing mappings are cached for `TMDB_MISS_CACHE_HOURS` (24 hours by default); transient TMDB failures are not cached.
- A visible row/screen becomes one Lampa HTTP batch after a 120 ms debounce. Max batch size is 60.
- If a card already contains `imdb_id`, the server accepts it and skips TMDB resolution.
- The IMDb non-commercial dataset is for personal/non-commercial use; verify IMDb terms for your deployment.
