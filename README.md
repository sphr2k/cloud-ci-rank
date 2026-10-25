# Cloud CI Rank

[**Live application**](https://cloud-ci-rank.janwer.workers.dev/) · [Spare Cores Keeper API](https://keeper.sparecores.net/docs)

A compact TypeScript SPA + Cloudflare Worker + D1 leaderboard for inexpensive, powerful CI workers. **Spare Cores is the sole data source.** No Vantage, Oracle pricing API, Python, Pyodide, or client-side tokens.

## Decision metric

**Default: measured multi-core compute performance per dollar** from `stress_ng:bestn` (maximum multi-core div16 ops/s). Compare at the full VM level, not per virtual thread:

```text
memory_factor = min(1, memory_GiB / (2 * vCPUs))
score = max_multicore_ops_per_second * memory_factor / VM_hourly_price_USD
```

A missing benchmark is **not assumed to be zero**; unmeasured candidates rank after measured ones. The score rewards throughput for independent parallel Go/Bun CI jobs. It is synthetic CPU throughput, **not** measured compilation time or guaranteed performance under shared-core contention.

`stress_ng:best1` provides the single-core ops/s alongside each result to identify potential serial-stage bottlenecks. We deliberately **do not fabricate a weighted composite**; benchmark real builds to calibrate a mix if necessary. The ranking selector can switch to **nominal 1 vCPU + 2 GiB RAM cost**, where `units = min(vCPUs, RAM_GiB / 2)` and score is USD/h divided by units.

## Data and limits

- Providers: AWS, GCP, Azure, Hetzner Cloud, OVH, UpCloud, Vultr, Alibaba Cloud. OCI is **not supported by Keeper and deliberately excluded**.
- Europe and USA only, max. 16 vCPU by default (8–64 selectable), x86/ARM, Spot/On-Demand.
- [Keeper `/servers`](https://keeper.sparecores.net/docs): 1 request for global single-core results, 1 per country for combined provider-specific prices and multi-core scores. Europe has 15 supported country codes plus US. ~29 /servers requests × 3 credits plus one region-catalog request = approximately 88 credits per refresh, below Keeper's 300 credits/min default. In response to 429/503, retries honor `Retry-After` with bounded backoff.
- AWS prices are collected **per actual AWS region** (using the Keeper regions filter), while other providers retain **country-minimum** prices. Neither reports exact availability-zone capacity. EU/US markets must not be conflated. Country availability and latency still require verification before deploying runners.
- Keeper source records are public, under **CC BY-SA 4.0**. Data attribution: [Spare Cores](https://sparecores.com/). API use is subject to [terms/fair use](https://sparecores.com/legal/terms-of-service).
- GitHub Actions refreshes every 6 hours via the same TypeScript parser (`src/keeper.ts`); Cloudflare Workers Free does no expensive upstream parsing. No API key required. Each provider's normalized price and benchmark records are hashed, and unchanged records cause **no D1 offers writes**.
- D1 is deliberately retained as the public caching/serving layer. The Worker uses **Drizzle ORM + Drizzle-generated Zod schemas** (`src/db/schema.ts`), with atomic version switch after validating all uploaded rows. Data reduction preserves each country's and AWS region's winning candidates across all six max-vCPU choices and both ranking metrics; this avoids incorrect cross-region comparisons.

## Develop

```sh
npm ci
npm run check
npm test
npm run dev
```

`wrangler.jsonc` binds D1 `cloud-ci-rank`, with migration SQL under `migrations/` and Drizzle metadata under `drizzle/`. The public endpoint is `/api/prices`; internal import endpoints require `IMPORT_TOKEN`, shared with the GitHub repository `CLOUD_CI_IMPORT_TOKEN` secret. `CLOUD_CI_RANK_URL` is the repository variable. Trigger [`Refresh cloud prices`](https://github.com/sphr2k/cloud-ci-rank/actions/workflows/prices.yml) to pull prices and publish into D1.

## Limitations

The results do not model boot time, cache warmup, total Go/Bun build walltime, EBS/Hyperdisk/D1 charges, egress, quota, spot reclamation or benchmark variance. They are for shortlisting hardware, not an empirical CI buildtime prediction.

## Isolated PR preview database

Cloudflare Workers Builds deploy PR previews against the separate D1 database
`cloud-ci-rank-preview` (WEUR). The `previews.d1_databases` binding in
`wrangler.jsonc` points exclusively to that database; previews must never
read or write the production `cloud-ci-rank` D1 binding. The preview database
is intentionally empty until migration tests initialize it separately.

## SuperSQLite Offer-only snapshots

Keeper API responses are normalized immediately to the existing `Offer` model,
reduced with `bestByGeo()` and `compactCandidates()`, then stored as JSON
in SuperSQLite on Cloudflare D1. **Full Keeper source objects are never
persisted.** Region-specific AWS pricing, single-/multi-core scores, and the
architecture filter are retained in the normalized `Offer` values.

Each D1 document contains a bounded page of up to 100 normalized Offers
(at most 48 KiB per HTTP upload); the generic SuperSQLite lifecycle handles
idempotent retries, completeness checks, and atomic per-provider publication.
This avoids one DB write per offer and avoids re-reading enormous upstream
source documents on each public request. No extra D1 migration is required:
we reuse the `keeper_documents`, `keeper_batches`, and `keeper_heads` tables.

The active snapshot digest is version-tagged with `offer-only-v1:`, which
prevents older mixed raw+offer snapshots from being mistaken for ready Offer-only
data. A new data refresh publishes complete per-provider snapshots while the
existing Drizzle cache remains available as a rollback path.

### Rollout and verification

1. Deploy the Offer-only Worker with `READ_KEEPER_SNAPSHOTS` unset. The
   existing `/api/prices` endpoint remains on its legacy data.
2. Trigger **Refresh cloud prices** from GitHub Actions. It uploads normalized
   Offer pages to `/api/snapshots/import/begin`, `/chunk`, and
   `/commit` using the existing `IMPORT_TOKEN` secret.
3. Verify `/api/snapshots/status` reports all eight providers ready and
   compare the authenticated `/api/snapshots/prices` response with
   legacy `/api/prices` (region coverage, offer totals, ranking, ARM/x86).
4. Set `READ_KEEPER_SNAPSHOTS=1` in `wrangler.jsonc` after all eight providers
   are verified (completed for the production cutover). Read errors continue
   to fall back to the legacy dataset.
5. Disable redundant legacy imports using the GitHub repository variable
   `CLOUD_CI_LEGACY_REFRESH=0`. Legacy SQL tables are kept for rollback,
   not dropped automatically.

Rollback: set `READ_KEEPER_SNAPSHOTS=0` and redeploy. The existing
`instances` data remains untouched by this migration. After the cutover,
old raw JSON snapshots may be pruned since legacy SQL remains available.

Only the scheduled 6-hour GitHub **Refresh cloud prices** workflow is used;
code pushes are built by Cloudflare Workers Builds, not duplicate GitHub CI.

## Location filter and Buildkite AMI preset

The location dropdown supports:
- All regions (default)
- Country minima across all eight providers
- Exact AWS regions, with region-specific Spot and On-Demand prices
- AWS · Buildkite-AMI-Regionen, an AWS-only preset for regions in the official Elastic CI Stack for AWS v1.4.0 AMI map

Buildkite native AMI regions in the supported app markets:
- EU: eu-central-1, eu-north-1, eu-south-1, eu-west-1, eu-west-2, eu-west-3
- US: us-east-1, us-east-2, us-west-1, us-west-2

Spain (eu-south-2) and Zurich (eu-central-2) have accurate regional prices and appear in the individual region selector, but **not** in the upstream v1.4.0 native AMI preset. A mapping is not proof of AMI accessibility in the AWS account or available Spot capacity.

Migration 0005_region_filter.sql adds region_id and country_code. Apply this before importing the new offers; historical AWS country minima will be replaced in the first completed refresh.
