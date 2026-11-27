# NYC Storefront Vacancy (`nycstorefront.com`)

An open-source, block-by-block explorer of New York City's commercial ground-floor storefronts, live at **[nycstorefront.com](https://nycstorefront.com)**.

Built with Svelte 5, SvelteKit, and MapLibre GL JS, it combines NYC Dept. of Finance storefront filings (`92iy-9c3n`, 2019–2025), the NYC Comptroller's quarterly storefront vacancy census, MapPLUTO parcel polygons, CSCL street centerlines, HPD ownership registrations, DOHMH/DCWP/Open Restaurants tenant records, DOB permits, OATH hearings, and 311 complaints into a fast street-level explorer.

## Key Features

- **City -> Cluster -> Block -> Building hierarchy**: 349 street-aligned commercial clusters built from contiguous blocks with similar vacancy rates.
- **True-scale block elevations**: Live MapPLUTO parcel raycasting showing real building widths, heights, corner wraps, business names, arrow-key block walking, and a playable 2019–2025 Time Machine.
- **Deduplicated NYC DOF filings**: Automatically strips NYC DOF's Feb/June double-counting (~1,800 duplicate vacant rows/year) and corrupted 2023–2025 activity codes, and links condo billing lots (`7500+`) to pre-condo and unit BBLs.
- **Building dossiers**: Interactive 2019–2025 occupancy bar charts with per-unit breakdowns, Landlord X-Ray (unmasking LLCs via HPD), Google Street View + Parcel + Aerial views, AI web-grounded Field Notes, and Street View Vision audits.
- **Universal instant search (`⌘K` / `/`)**: Local cluster search, NYC GeoSearch address autocomplete, geolocation ("My Block"), and natural-language AI search.

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The app runs out of the box with zero API keys using the bundled cluster/block datasets and public NYC Open Data APIs.

### Optional Environment Variables (`.env`)

- `GOOGLE_MAPS_API_KEY`: Enables Google Street View facade imagery on building pages.
- `OPENROUTER_API_KEY`: Enables natural-language AI search, cluster takeaways, web-grounded building Field Notes, and Street View Vision audits.
- `CACHE_DIR`: Optional directory for persistent stale-while-revalidate disk caching (defaults to `/tmp/nycstorefront-cache`; set to `/data/cache` on Railway with a mounted volume).
- `STATS_SECRET`: Optional passcode that enables the private, cookie-free visitor analytics dashboard at `/stats` (persisted alongside `CACHE_DIR` in `/data/analytics`).

## Data Pipeline & Tests

```bash
# Re-sync official NYC Open Data & rebuild cluster shards
npm run sync:data

# Rebuild the pre-baked citywide business-name index
node scripts/build-tenants-index.mjs

# Run deduplication & tie-out tests + Svelte type checks
npm test
npm run check

# Smoke-test block raycasting across all 5 boroughs
npm run smoke -- https://nycstorefront.com
```

## Deploying (Node / Railway)

The project uses `@sveltejs/adapter-node` with precompression enabled (`railway.json` included):

```bash
npm run build
npm run start
```

Set `HOST=0.0.0.0`, `NODE_ENV=production`, `PROTOCOL_HEADER=x-forwarded-proto`, and `HOST_HEADER=x-forwarded-host` behind a reverse proxy (and optionally mount a volume at `/data` with `CACHE_DIR=/data/cache`).

## License

[MIT](./LICENSE) — Copyright (c) 2026 Paul Wolpe. Public data originates from NYC Open Data, NYC Dept. of Finance, NYC Comptroller, NYC Planning, HPD, DOHMH, DCWP, DOB, OATH, and 311.
