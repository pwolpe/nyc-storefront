# Gates Down NYC

An unofficial, blazingly fast, stop-motion claymation explorer for New York City’s **16,047 empty storefronts**—combining the **NYC Comptroller’s quarterly Live XYZ ground surveys** with **NYC Dept. of Finance (DOF) Local Law 157 filings (`92iy-9c3n`)**, **PLUTO landlord records**, **311 smoke-shop complaints**, and a neighbor **Street Truth / Padlock Ghost** layer.

Built to be fun enough to share on social media—and rigorously tied out enough to send directly to your City Council Member and the Comptroller.

## Stack
- **Svelte 5 (Runes) + SvelteKit** (`@sveltejs/adapter-cloudflare`)
- **Cloudflare Workers + D1 (edge SQLite) + Cron Triggers** (`wrangler.jsonc`)
- **MapLibre GL JS + OpenFreeMap Positron** (60fps vector maps, $0 Mapbox bill)
- **Pre-optimized WebP claymation cast** (380 KB total across all 6 scenes) + repeatable OpenRouter / Nano Banana script (`scripts/paint.mjs`)

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:5173` — works out of the box with zero API keys (uses real bundled Q3 2026 Comptroller + DOF 2019–2025 data and falls back to an in-memory Street Truth store when D1 isn’t attached).

## Refreshing Live Official NYC Data

Anytime the Comptroller publishes a new quarter (or DOF updates `92iy-9c3n`), re-sync and mathematically tie out every dataset in one command:

```bash
npm run sync:data
npm test
```

## Painting More Claymation Scenes (OpenRouter / Nano Banana)

```bash
OPENROUTER_API_KEY=sk-or-... npm run paint -- corridor-8th-ave
```

## Deploying to Cloudflare Workers (`wolpe.co` or custom domain)

```bash
npx wrangler login
npx wrangler d1 create gates-down-db
# Paste the returned database_id into wrangler.jsonc
npm run db:migrate:remote
npm run deploy
```
