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

async function verifyOfferSnapshots(grouped: Record<string, import('../src/pricing').Offer[]>): Promise<void> {
  const response=await fetch(endpoint+'/api/snapshots/prices',{
    headers:{authorization:'Bearer '+token,'cache-control':'no-cache'}
  });
  if(!response.ok) throw new Error('Offer snapshot read verification failed: HTTP '+response.status+' '+(await response.text()).slice(0,200));
  const data=await response.json() as {offers:import('../src/pricing').Offer[]};
  if(!Array.isArray(data.offers)) throw new Error('Snapshot returned no Offer array');
  const actual=new Map<string,import('../src/pricing').Offer[]>();
  for(const offer of data.offers){
    if(!actual.has(offer.provider))actual.set(offer.provider,[]);
    actual.get(offer.provider)!.push(offer);
  }
  for(const vendor of KEEPER_VENDORS){
    const expected=grouped[vendor],received=actual.get(vendor)??[];
    if(expected.length!==received.length||snapshotDigest(expected)!==snapshotDigest(received)){
      throw new Error(vendor+' snapshot verification mismatch: expected '+expected.length+', received '+received.length);
    }
    console.log(vendor,'Offer-only snapshot verified:',received.length,'Offers');
  }
  if(data.offers.length!==Object.values(grouped).reduce((sum,rows)=>sum+rows.length,0)){
    throw new Error('Snapshot contains unexpected extra Offer records');
  }
  // Confirm the public endpoint actually routes to SuperSQLite, rather than
  // returning a matching dataset through its legacy SQL fallback.
  const publicResponse=await fetch(endpoint+'/api/prices?cutover-verify=1',{
    headers:{'cache-control':'no-cache'}
  });
  if(!publicResponse.ok || publicResponse.headers.get('etag')!==response.headers.get('etag')) {
    throw new Error('Public /api/prices does not serve the verified SuperSQLite snapshot');
  }
  const published=await publicResponse.json() as {offers:import('../src/pricing').Offer[]};
  if(!Array.isArray(published.offers)||published.offers.length!==data.offers.length) {
    throw new Error('Public /api/prices Offer count differs from SuperSQLite snapshot');
  }
  console.log('Public Offer-only cutover verified:',published.offers.length,'Offers');
}

async function main(): Promise<void> {
  const available=await snapshotAvailable();
  const grouped=await fetchKeeperAll();
  if (available) {
    await publishOffers(grouped,available);
    // Verify the actual production Worker read path, not just SQL row counts.
    await verifyOfferSnapshots(grouped);
  } else console.log('Offer snapshot endpoint not deployed; continuing legacy ingestion');
  // Retain legacy writes until production read cutover is verified.
  if (process.env.CLOUD_CI_LEGACY_REFRESH !== '0' || !available) await publishLegacy(grouped);
}
await main();
