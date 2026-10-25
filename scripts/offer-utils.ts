import { createHash } from 'node:crypto';
import type { Offer } from '../src/pricing';
import { OFFER_SNAPSHOT_VERSION } from '../src/snapshot-schema';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, data: unknown) => data !== null && typeof data === 'object' && !Array.isArray(data)
    ? Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)))
    : data);
}

/** Hash precisely what gets persisted, including region/arch/benchmark metadata. */
export function snapshotDigest(offers: readonly Offer[]): string {
  const documents = offers.map(canonicalJson).sort();
  const hash = createHash('sha256').update(OFFER_SNAPSHOT_VERSION).update('\n')
    .update(JSON.stringify(documents)).digest('hex');
  return `${OFFER_SNAPSHOT_VERSION}:${hash}`;
}

/** Preserve old legacy digest semantics during the brief dual-write period. */
export function digestOffers(offers: readonly Offer[]): string {
  const normalized = offers.map(x => [x.instance,x.family,x.arch,x.processor,x.vcpu,x.ram,x.model,
    x.hour_usd,x.region,x.regionId,x.countryCode,x.geo,x.benchAll,x.benchSingle])
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** Bound D1/Worker HTTP payloads; separate batch offsets are retry-safe. */
export function offerChunks(batchId: string, offers: readonly Offer[]): {offset: number; offers: Offer[]}[] {
  const chunks: {offset: number; offers: Offer[]}[] = [];
  for(let cursor=0; cursor<offers.length;) {
    const offset=chunks.length; // SuperSQLite stores ONE document per page.
    const selected: Offer[] = [];
    while(cursor+selected.length<offers.length && selected.length<100) {
      const next=offers[cursor+selected.length];
      if(Buffer.byteLength(JSON.stringify({batchId,offset,offers:[...selected,next]}))>48_000) break;
      selected.push(next);
    }
    if(!selected.length) throw new Error('Offer exceeds 48 KiB chunk budget');
    chunks.push({offset,offers:selected});
    cursor+=selected.length;
  }
  return chunks;
}
