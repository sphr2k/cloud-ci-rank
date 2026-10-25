import { type } from 'arktype';
import { createSnapshotStore } from 'supersqlite';
import { D1Adapter } from 'supersqlite/d1';
import type { D1Database } from '@cloudflare/workers-types';

/** Raw source JSON remains intact, including unknown upstream Keeper fields. */
const KeeperRawEntry = type({
  kind: "'raw'",
  country: 'string',
  raw: {
    vendor_id: 'string', server_id: 'string', name: 'string',
    vcpus: 'number', memory_amount: 'number'
  },
  single: 'number | null'
});

/** Materialized API payload from the same atomic batch, small and indexed. */
const OfferEntry = type({
  kind: "'offer'",
  offer: {
    provider: "'AWS' | 'GCP' | 'AZURE' | 'HCLOUD' | 'OVH' | 'UPCLOUD' | 'VULTR' | 'ALICLOUD'",
    instance: 'string', family: 'string', arch: 'string', processor: 'string',
    vcpu: 'number', ram: 'number', model: "'Spot' | 'On-Demand'",
    hour_usd: 'number', region: 'string', geo: "'eu' | 'us' | 'global'",
    source: 'string', evidence: 'string', asof: 'string', data_class: 'string',
    interruption: 'string | null', benchAll: 'number | null', benchSingle: 'number | null'
  }
});

export const KeeperRaw = KeeperRawEntry;
export const KeeperStored = KeeperRawEntry.or(OfferEntry);
export type KeeperStored = typeof KeeperStored.infer;
export const snapshotStore = (db: D1Database) => createSnapshotStore(
  'keeper', KeeperStored, new D1Adapter(db)
);
