import { type } from 'arktype';
import { createSnapshotStore } from 'supersqlite';
import { D1Adapter } from 'supersqlite/d1';
import type { D1Database } from '@cloudflare/workers-types';

/** Exactly the normalized Offer JSON sent to clients; no Keeper raw payloads. */
export const OfferSchema = type({
  provider: "'AWS' | 'GCP' | 'AZURE' | 'HCLOUD' | 'OVH' | 'UPCLOUD' | 'VULTR' | 'ALICLOUD'",
  instance: 'string', family: 'string', arch: 'string', processor: 'string',
  vcpu: 'number', ram: 'number', model: "'Spot' | 'On-Demand'",
  hour_usd: 'number', region: 'string', 'regionId?': 'string | null',
  'countryCode?': 'string | null', geo: "'eu' | 'us' | 'global'",
  source: 'string', evidence: 'string', asof: 'string', data_class: 'string',
  interruption: 'string | null', benchAll: 'number | null', benchSingle: 'number | null'
});

/** One persisted SuperJSON row contains a small page of normalized Offers.
 * This bounds SQLite write/read overhead without persisting upstream payloads. */
export const OfferPageSchema = type({offers: OfferSchema.array()});

/** Versioned digest prevents a prior raw+offer snapshot being mistaken as active. */
export const OFFER_SNAPSHOT_VERSION = 'offer-only-v1';
export const snapshotStore = (db: D1Database) => createSnapshotStore(
  'keeper', OfferPageSchema, new D1Adapter(db)
);
