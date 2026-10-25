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
