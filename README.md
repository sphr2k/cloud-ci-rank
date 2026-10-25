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
- [Keeper `/servers`](https://keeper.sparecores.net/docs): 1 request for global single-core results, 1 per country for combined provider-specific prices and multi-core scores. Europe has 15 supported country codes plus US. ~17 requests × 3 credits = 51 credits per refresh, below Keeper's 300 credits/min default. In response to 429/503, retries honor `Retry-After` with bounded backoff.
- Only **country-minimum** hourly prices are known from this endpoint, not the exact AZ and not actual purchasable Spot capacity. EU/US markets must not be conflated. Country availability and latency still require verification before deploying runners.
- Keeper source records are public, under **CC BY-SA 4.0**. Data attribution: [Spare Cores](https://sparecores.com/). API use is subject to [terms/fair use](https://sparecores.com/legal/terms-of-service).
- GitHub Actions refreshes every 6 hours via the same TypeScript parser (`src/keeper.ts`); Cloudflare Workers Free does no expensive upstream parsing. No API key required. Each provider's normalized price and benchmark records are hashed, and unchanged records cause **no D1 offers writes**.
- D1 is deliberately retained as the public caching/serving layer. The Worker uses **Drizzle ORM + Drizzle-generated Zod schemas** (`src/db/schema.ts`), with atomic version switch after validating all uploaded rows. Data reduction preserves winning candidates across all six max-vCPU choices and both ranking metrics.

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

## SuperSQLite raw Keeper snapshots (additive rollout)

The latest pipeline keeps the **original Keeper `/servers` JSON** as typed
SuperSQLite documents in Cloudflare D1. The attached context includes the
country queried, exact AWS region where applicable, and single-core score
from the separate Keeper benchmark endpoint. Unknown source fields, nested CPU metadata, and future attributes
are preserved, not flattened into a relational `instances` schema.

Each snapshot contains **two kinds of JSON documents** within one atomic
batch: `kind: 'raw'` for the source record, and `kind: 'offer'` for a compact
materialized ranking offer computed by the existing TypeScript normalizer.
An expression index over `(batchId, kind)` makes public requests read only the
small materialized offers. The full source remains available for audits and
reprocessing; no country-by-country raw scan occurs on public requests.

### Deployment and cutover

1. `npm ci && npm run check && npm test` – compile, typecheck, and exercise
   genuine workerd/D1 integration tests. Check this on GitHub CI before deploy.
2. Apply **additive migrations 0005_region_filter and 0006_keeper_snapshots** to the D1 binding *before* deploying the
   Worker. Use `npx wrangler d1 migrations apply cloud-ci-rank --remote` (with
   authorized Cloudflare credentials). **Do not drop the legacy tables.**
3. Deploy with the existing Worker configuration (`npm run deploy`).
   `READ_KEEPER_SNAPSHOTS` is deliberately unset. Existing `/api/prices`
   therefore continues to serve Drizzle's `instances` table.
4. Trigger the existing **Refresh cloud prices** workflow. It will populate
   raw and materialized snapshots for all eight providers while continuing
   to refresh the legacy path. Repeated source digests skip D1 writes.
5. Verify `/api/raw/status` reports `ready: true` and compare authenticated
   `GET /api/raw/prices` against public `GET /api/prices`: provider coverage,
   count, ranking inputs, price values, and UI across EU/US and CPU filters.
   The raw preview requires `Authorization: Bearer <IMPORT_TOKEN>`.
6. **Only after verification**, explicitly enable `READ_KEEPER_SNAPSHOTS=1`
   as a Worker environment variable and deploy. The public endpoint switches
   to the compact, materialized SuperSQLite snapshot and continues to fall
   back to the unchanged legacy data if the raw read fails.
7. Once observed healthy across refreshes, optionally set the GitHub workflow
   environment variable `CLOUD_CI_LEGACY_REFRESH=0`. This stops writing legacy
   offers but does not delete their tables. Keep it unset until then.

Rollback: remove `READ_KEEPER_SNAPSHOTS` (or set it to `0`) and redeploy to
restore legacy reads. Keep legacy refreshing during initial observation.
The new `keeper_*` tables and documents are not required for rollback.

### Import lifecycle and reliability

`/api/raw-import/begin`, `/chunk`, `/commit`, `/status`, and `/prune` require the
same `IMPORT_TOKEN` used by the legacy import endpoints. Upload chunks contain
at most 20 documents and are bounded to approximately 48 KiB on the client.
SuperSQLite uses deterministic per-batch IDs and rejects conflicting retries.
Publication checks the total document count and presence of both raw and
materialized types, then atomically updates the D1 head; incomplete or competing batches cannot become visible.
After successful publication the previous snapshot is retained for rollback,
and only an older grandparent may be pruned. If cleanup fails, the refresh
continues safely; orphaned pending batches can be reviewed separately.

The raw-source digest includes a `MATERIALIZATION_VERSION` token; bump this
whenever normalized offer semantics change so existing Keeper input is
reprocessed into a fresh materialized snapshot.

**Capacity warning:** Full Keeper records are substantially larger than
compact offers (a recent Germany query returned 1,766 objects (1,723 with usable offers)
and about 5.9 MB of JSON; the largest eligible source record was 4.7 KiB). Raw storage and full refreshes therefore consume additional
D1 writes/storage and upstream API traffic. Monitor Cloudflare's D1 quotas and
Worker cost after rollout. Do not enable read cutover or remove old tables
before measuring these operational effects.

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
