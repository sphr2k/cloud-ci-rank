import { fetchKeeperAll, KEEPER_VENDORS } from '../src/keeper';
import { digestOffers, snapshotDigest, offerChunks } from './offer-utils';

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

async function snapshotAvailable(): Promise<SourceState | null> {
  const res = await fetch(endpoint + '/api/snapshots/sources');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Offer snapshots unavailable: HTTP ' + res.status);
  return res.json() as Promise<SourceState>;
}

async function publishOffers(grouped: Record<string, import('../src/pricing').Offer[]>, old: SourceState): Promise<void> {
  for (const vendor of KEEPER_VENDORS) {
    const offers = grouped[vendor];
    const digest = snapshotDigest(offers);
    if (old[vendor]?.digest === digest) {
      console.log(vendor, 'offers unchanged; no D1 writes');
      continue;
    }
    const started=Date.now();
    const chunks=offerChunks('01K00000000000000000000000',offers);
    const begin=await post<{status:'unchanged'|'upload';batchId:string}>('/api/snapshots/import/begin', {
      provider:vendor, digest, expectedRows:chunks.length
    });
    if (begin.status === 'unchanged') continue;
    for (let i=0;i<chunks.length;i+=8) {
      await Promise.all(chunks.slice(i,i+8).map(chunk => post('/api/snapshots/import/chunk', {
        batchId:begin.batchId, ...chunk
      })));
    }
    const committed=await post<{status:string;provider:string;count:number;previousBatchId:string|null}>(
      '/api/snapshots/import/commit',{batchId:begin.batchId});
    if (committed.status!=='committed'||committed.provider!==vendor||committed.count!==chunks.length) {
      throw new Error(vendor+' Offer snapshot did not publish expected rows');
    }
    console.log(vendor,'published',offers.length,'Offers in',chunks.length,'documents in',Date.now()-started,'ms');
    // Keep the previous published generation for rollback; prune grandparent.
    if (committed.previousBatchId) {
      try {
        const parent=await post<{parentBatchId:string|null}>('/api/snapshots/import/status',{
          batchId:committed.previousBatchId
        });
        if (parent.parentBatchId) await post('/api/snapshots/import/prune', {batchId:parent.parentBatchId});
      } catch(error) { console.warn(vendor,'old snapshot cleanup deferred:',error); }
    }
  }
}

async function publishLegacy(grouped: Record<string, import('../src/pricing').Offer[]>): Promise<void> {
  const old = await get<SourceState>('/api/sources');
  for (const vendor of KEEPER_VENDORS) {
    const offers = grouped[vendor];
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
  const available=await snapshotAvailable();
  const grouped=await fetchKeeperAll();
  if (available) await publishOffers(grouped,available);
  else console.log('Offer snapshot endpoint not deployed; continuing legacy ingestion');
  // Retain legacy writes until production read cutover is verified.
  if (process.env.CLOUD_CI_LEGACY_REFRESH !== '0' || !available) await publishLegacy(grouped);
}
await main();
