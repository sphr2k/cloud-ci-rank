import { fetchKeeperRawAll, offersFromKeeperRaw, KEEPER_VENDORS, type KeeperRawDocument } from '../src/keeper';
import { digestOffers, digestRaw, rawChunks } from './raw-utils';
import type { KeeperStored } from '../src/raw-schema';

const endpoint = process.env.CLOUD_CI_RANK_URL?.replace(/\/+$/, '');
const token = process.env.CLOUD_CI_IMPORT_TOKEN;
if (!endpoint || !token) throw new Error('CLOUD_CI_RANK_URL and CLOUD_CI_IMPORT_TOKEN required');

async function get<T>(path: string): Promise<T> {
  const res = await fetch(endpoint + path);
  if (!res.ok) throw new Error('GET ' + path + ': HTTP ' + res.status);
  return res.json() as Promise<T>;
}
async function post<T>(path: string, data: unknown): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(endpoint + path, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(data)
    });
    if (res.ok) return res.json() as Promise<T>;
    const detail = (await res.text()).slice(0, 400);
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new Error('POST ' + path + ': HTTP ' + res.status + ' ' + detail);
    }
    if (attempt === 2) throw new Error('POST ' + path + ': HTTP ' + res.status + ' ' + detail);
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error('unreachable');
}

type SourceState = Record<string, {digest: string | null}>;

async function rawAvailable(): Promise<SourceState | null> {
  const res = await fetch(endpoint + '/api/raw/sources');
  // Safe transition: old production Worker has no raw endpoint until deployed.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Raw snapshot endpoint returned HTTP ' + res.status + '; apply additive D1 migration before Worker deploy');
  return res.json() as Promise<SourceState>;
}

async function publishRaw(grouped: Record<string,KeeperRawDocument[]>, old: SourceState): Promise<void> {
  for (const vendor of KEEPER_VENDORS) {
    const docs = grouped[vendor];
    // Raw source + compact materialized Offers share the same atomic snapshot.
    const offers = offersFromKeeperRaw(docs);
    const stored: KeeperStored[] = [
      ...docs.map(doc => ({...doc, kind: 'raw' as const})),
      ...offers.map(offer => ({kind: 'offer' as const, offer}))
    ];
    const digest = digestRaw(docs);
    if (old[vendor]?.digest === digest) {
      console.log(vendor, 'raw unchanged; no D1 snapshot writes');
      continue;
    }
    const start = Date.now();
    const begin = await post<{status: 'unchanged' | 'upload';batchId:string}>('/api/raw-import/begin', {
      provider: vendor, digest, expectedRows: stored.length
    });
    if (begin.status === 'unchanged') continue;
    // Disjoint offset ranges remain idempotent; bounded parallel HTTP uploads
    // avoid running past the scheduled workflow deadline on full Keeper data.
    const chunks = rawChunks(begin.batchId, stored);
    for (let i = 0; i < chunks.length; i += 8) {
      await Promise.all(chunks.slice(i, i + 8).map(chunk =>
        post('/api/raw-import/chunk', {batchId: begin.batchId, ...chunk})
      ));
    }
    const committed = await post<{status:string;provider:string;count:number;previousBatchId:string|null}>('/api/raw-import/commit', {
      batchId: begin.batchId
    });
    if (committed.status !== 'committed' || committed.provider !== vendor || committed.count !== stored.length) {
      throw new Error(vendor + ' raw snapshot failed to publish expected rows');
    }
    console.log(vendor, 'raw snapshot', docs.length, 'source documents +', offers.length, 'materialized offers; time', Date.now()-start, 'ms');
    // Retain the previous generation for rollback and in-flight requests.
    // Prune only the grandparent after successful publication; errors are nonfatal.
    if (committed.previousBatchId) {
      try {
        const parent = await post<{parentBatchId:string|null}>('/api/raw-import/status', {batchId: committed.previousBatchId});
        if (parent.parentBatchId) {
          await post('/api/raw-import/prune', {batchId: parent.parentBatchId});
          console.log(vendor, 'pruned obsolete raw snapshot', parent.parentBatchId);
        }
      } catch (error) { console.warn(vendor, 'snapshot cleanup deferred:', error); }
    }
  }
}

async function publishLegacy(grouped: Record<string,KeeperRawDocument[]>): Promise<void> {
  const old = await get<SourceState>('/api/sources');
  for (const vendor of KEEPER_VENDORS) {
    const offers = offersFromKeeperRaw(grouped[vendor]);
    const digest = digestOffers(offers);
    if (old[vendor]?.digest === digest) {
      console.log(vendor, 'legacy unchanged; no D1 offer writes');
      continue;
    }
    const start = Date.now();
    const begin = await post<{status:'unchanged'|'upload';batchId?:string}>('/api/import/begin', {
      provider:vendor, digest, etag:null, expectedRows:offers.length
    });
    if (begin.status === 'unchanged') continue;
    if (!begin.batchId) throw new Error(vendor + ' missing batch');
    for (let offset = 0; offset < offers.length; offset += 10) {
      await post('/api/import/chunk', {batchId: begin.batchId, offset, offers: offers.slice(offset, offset+10)});
    }
    const result = await post<{status:string;count:number}>('/api/import/commit', {batchId: begin.batchId});
    if (result.status !== 'committed' || result.count !== offers.length) throw new Error(vendor + ' legacy commit failed');
    console.log(vendor, 'legacy', result.count, 'offers; time', Date.now()-start, 'ms');
  }
}

async function main(): Promise<void> {
  const available = await rawAvailable();
  const grouped = await fetchKeeperRawAll();
  if (available) await publishRaw(grouped, available);
  else console.log('Raw D1 endpoint not deployed; falling back to legacy-only imports');
  // Keep current public prices fresh until explicit READ_KEEPER_SNAPSHOTS cutover.
  if (process.env.CLOUD_CI_LEGACY_REFRESH !== '0' || !available) await publishLegacy(grouped);
}

await main();
