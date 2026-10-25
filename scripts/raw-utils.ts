import { createHash } from 'node:crypto';
import type { KeeperRawDocument } from '../src/keeper';
import type { Offer } from '../src/pricing';
import type { KeeperStored } from '../src/raw-schema';

export function digestOffers(offers: Offer[]): string {
  const normalized = offers.map(x => [
    x.instance, x.family, x.arch, x.processor, x.vcpu, x.ram, x.model,
    x.hour_usd, x.region, x.geo, x.benchAll, x.benchSingle
  ]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** Stable object-key ordering prevents false digest changes on JSON key reordering. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, data: unknown) => {
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      return Object.fromEntries(Object.entries(data).sort(([a],[b]) => a.localeCompare(b)));
    }
    return data;
  });
}
// Bump this token whenever normalized/materialized offer semantics change.
// A new code version then reprocesses unchanged upstream Keeper data.
export const MATERIALIZATION_VERSION = 'keeper-offer-v1';
export function digestRaw(documents: readonly KeeperRawDocument[]): string {
  const canonical = documents.map(canonicalJson).sort();
  return createHash('sha256').update(MATERIALIZATION_VERSION).update('\n').update(JSON.stringify(canonical)).digest('hex');
}

export function rawChunks(batchId: string, docs: readonly KeeperStored[]): {offset: number;docs: KeeperStored[]}[] {
  const result: {offset: number;docs: KeeperStored[]}[] = [];
  for (let offset = 0; offset < docs.length;) {
    const chunk: KeeperStored[] = [];
    while (offset + chunk.length < docs.length && chunk.length < 20) {
      const next = docs[offset + chunk.length];
      const bytes = Buffer.byteLength(JSON.stringify({batchId, offset, docs: [...chunk, next]}));
      if (bytes > 48_000) break;
      chunk.push(next);
    }
    if (!chunk.length) throw new Error('Keeper source record exceeds 48 KiB import payload');
    result.push({offset,docs:chunk});
    offset += chunk.length;
  }
  return result;
}
