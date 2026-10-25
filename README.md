# Cloud CI Price Leaderboard

Minimal **TypeScript SPA + Cloudflare Worker + D1** for comparing AWS/GCP/OCI VM prices per `1 advertised vCPU + 2 GiB RAM` hour. [Live dashboard](https://cloud-ci-rank.janwer.workers.dev/).

Europe and USA are enabled by default (Asia excluded), max vCPUs defaults to **16**. Rankings include x86-64, ARM64, Spot and On-Demand, choose the cheapest region per instance family and size, and display OCI A4 Preemptible with a clearly marked modeled 50% discount. The score measures **capacity price, not CPU performance**.

## Architecture

- **Public Worker** (`src/worker.ts`): serves HTML/SPA and `/api/prices` from Cloudflare D1. On Workers Free there is a 10ms CPU cap, so it does **not** parse the 319MB upstream AWS JSON.
- **GitHub Actions** (`.github/workflows/prices.yml`): runs TypeScript importer every six hours; can also be triggered manually. It streams Vantage AWS/GCP feeds (`src/feeds.ts`) and fetches Oracle PAYG SKUs.
- **Change detection**: AWS sends `If-None-Match` using the stored ETag; GCP lacks an ETag, so the small (~6MB) feed is downloaded and the normalized offers hashed. OCI SKU responses are likewise normalized and hashed. If the content digest is unchanged, **no D1 offer rows are rewritten**.
- **Drizzle + Zod**: `src/db/schema.ts` is the source of truth. Generated `Instance` Zod schema validates normalized offers before D1 insertion. Migrations in `migrations/` are generated from the Drizzle schema (`drizzle/` retains generator snapshots).
- **Atomic publication**: uploader stages batches of 10 offers, in D1 inserts of 5 rows (SQLite bound-variable limit), then commits only when the full expected row count is present. Until commit, readers see the previous complete snapshot.
- **Snapshot**: `data/region_snapshot.json` is an explicitly dated, reduced fallback for uninitialized D1. It is **not** treated as current live prices.

### Running

```sh
npm ci
npm run check
npm test
npm run dev
```

The Cloudflare D1 database is `cloud-ci-rank` (ID configured in `wrangler.jsonc`). The live worker is `cloud-ci-rank.janwer.workers.dev`.

### Refresh

GitHub Actions uses repository variable `CLOUD_CI_RANK_URL` and secret `CLOUD_CI_IMPORT_TOKEN`. The same secret is a Worker `IMPORT_TOKEN` secret binding. To run manually:

```sh
CLOUD_CI_RANK_URL=https://cloud-ci-rank.janwer.workers.dev \
CLOUD_CI_IMPORT_TOKEN=... npm run prices:refresh
```

`POST /api/import/begin`, `/api/import/chunk`, `/api/import/commit` require `Authorization: Bearer <IMPORT_TOKEN>`; the public API never exposes the token. `GET /api/sources` exposes only the stored source ETag, normalized digest, and timestamps. D1 state is per-provider and independent across refresh failures.

### Limitations

AWS Vantage Linux Spot is a 7-day average, GCP Spot is published regional pricing; neither confirms available Spot capacity. OCI A4/E4/E5/E6 Preemptible is modeled at 50% off public CPU + RAM PAYG SKUs and **does not confirm availability in a selected region**. OCI A1 is intentionally omitted; A2 has no modeled Preemptible. GPU, shared-CPU, bare metal, burstable AWS and non-EU/non-US regions are excluded from the discovery input. Cloud compute/VM-start cost, disk, egress, quotas, CPU-generation benchmarking, and actual build speed are not included in the score.
