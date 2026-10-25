import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { fetchKeeperRawAll, keeperRows, offersFromKeeperRaw, KEEPER_VENDORS, type KeeperRawDocument } from '../src/keeper';
import { digestOffers, digestRaw, rawChunks } from '../scripts/raw-utils';

const vendorIds: Record<string,string> = {
  AWS:'aws',GCP:'gcp',AZURE:'azure',HCLOUD:'hcloud',OVH:'ovh',
  UPCLOUD:'upcloud',VULTR:'vultr',ALICLOUD:'alicloud'
};
function doc(provider:string, number = 0):KeeperRawDocument {
  return {
    country: number === 0 ? 'DE' : 'US',
    single: 500 + number,
    ...(provider==='AWS'?{awsRegion:{regionId:number===0?'eu-central-1':'us-east-1',name:number===0?'Frankfurt':'N. Virginia',country:number===0?'DE':'US'}}:{}),
    raw: {
      vendor_id: vendorIds[provider],
      server_id: provider + '-' + number,
      name: provider + '-' + number,
      vcpus: 8, memory_amount: 16384,
      cpu_architecture:'arm64',
      cpu_model:'Test CPU', family:'test',
      status:'active',
      min_price_spot: 0.1 + number * 0.02,
      min_price_ondemand: 0.3 + number * 0.02,
      selected_benchmark_score: 15000 + number * 100,
      observed_at:'2026-10-25',
      unknown_future_attribute: { foo: ['bar'], sourceVersion: 12 }
    }
  };
}
function rawDoc(provider:string,number=0): KeeperRawDocument {return doc(provider,number);}
async function request(mf:Miniflare,path:string, init:Parameters<Miniflare['dispatchFetch']>[1]={}) {
  return mf.dispatchFetch('https://unit.test'+path, init);
}
async function post(mf:Miniflare,path:string,body:unknown,token='secret') {
  return request(mf,path, {method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
}

test('Keeper raw normalization retains source JSON and rankings exactly', () => {
  const documents=[doc('AWS',0),doc('AWS',1),doc('GCP',0)];
  const derived=offersFromKeeperRaw(documents);
  assert.ok(derived.length>0);
  assert.deepEqual(derived, derived.slice().sort((a,b)=>0) /* stable deterministic order */);
  assert.deepEqual(documents[0].raw.unknown_future_attribute, {foo:['bar'],sourceVersion:12});
  assert.ok(keeperRows([documents[0].raw],'DE',new Map()).length===2);
  assert.equal(digestRaw(documents), digestRaw(documents.map(d => ({
    ...d,
    raw: Object.fromEntries(Object.entries(d.raw).reverse()) as unknown as KeeperRawDocument['raw']
  }))));
  assert.notEqual(digestRaw(documents), digestRaw([documents[0]]));
  const reference=offersFromKeeperRaw(documents).filter(x=>x.provider==='AWS');
  const changed=reference.map(x=>({...x,regionId:'eu-central-2'}));
  assert.notEqual(digestOffers(reference),digestOffers(changed));
  assert.notEqual(digestOffers(reference),digestOffers(reference.map(x=>({...x,countryCode:'CH'}))));

  const groups=rawChunks('01KANABCDABCDFACED',documents.map(d=>({...d,kind:'raw' as const})));
  assert.equal(groups.reduce((sum,b)=>sum+b.docs.length,0),documents.length);
  assert.deepEqual(groups.map(x=>x.offset),[0]);
});

test('Keeper fetch stores eligible original server records, country and separate single-core scores', async () => {
  const singleRows=Array.from({length:101},(_,i)=>({vendor_id:'aws',server_id:'mock-'+i,selected_benchmark_score:1200}));
  singleRows.push(...KEEPER_VENDORS.map(v=>({vendor_id:vendorIds[v],server_id:v+'-0',selected_benchmark_score:1234})));
  const requested:string[]=[];
  const mock=async (resource:RequestInfo|URL):Promise<Response>=>{
    const url=new URL(String(resource));
    requested.push(url.toString());
    if(url.searchParams.get('benchmark_id')==='stress_ng:best1')return Response.json(singleRows);
    if(url.pathname==='/table/region')return Response.json([
      {vendor_id:'aws',status:'active',country_id:'DE',region_id:'eu-central-1',display_name:'Frankfurt'},
      {vendor_id:'aws',status:'active',country_id:'US',region_id:'us-east-1',display_name:'N. Virginia'}
    ]);
    if(url.searchParams.has('regions'))return Response.json([doc('AWS',url.searchParams.get('regions')==='eu-central-1'?0:1).raw]);
    const country=url.searchParams.get('countries');
    if(country!=='DE' && country!=='US')return Response.json([]);
    return Response.json(KEEPER_VENDORS.filter(v=>v!=='AWS').map(v=>doc(v,0).raw));
  };
  const result=await fetchKeeperRawAll(mock as typeof fetch);
  assert.equal(requested.length,20);
  for(const provider of KEEPER_VENDORS){
    assert.equal(result[provider].length,2);
    assert.deepEqual(result[provider].map(d=>d.country).sort(),['DE','US']);
    assert.deepEqual(result[provider][0].raw.unknown_future_attribute,{foo:['bar'],sourceVersion:12});
    assert.equal(result[provider][0].single,1234);
  }
  assert.deepEqual(offersFromKeeperRaw(result.AWS).length>0,true);
});

test('raw D1 schema absent: report migration-needed, keep legacy refresh/read alive', async () => {
  const mf=new Miniflare({
    modules:true,
    script:readFileSync('dist/worker.mjs','utf8'),
    compatibilityDate:'2026-08-06',
    d1Databases:{DB:'cloud-ci-rank-no-raw-schema'},
    bindings:{IMPORT_TOKEN:'secret',READ_KEEPER_SNAPSHOTS:'1'}
  });
  try {
    const db=await mf.getD1Database('DB');
    // Production has these tables from the original relational migration.
    await db.prepare(`CREATE TABLE sources (
      provider TEXT PRIMARY KEY,etag TEXT,content_digest TEXT,active_batch TEXT,
      checked_at TEXT NOT NULL,changed_at TEXT NOT NULL,error TEXT
    )`).run();
    let res=await request(mf,'/api/health');
    assert.equal(res.status,200);
    res=await request(mf,'/api/raw/status');
    assert.equal(res.status,200);
    assert.deepEqual(await res.json(),{
      ready:false,migrationRequired:true,present:[],missing:[...KEEPER_VENDORS]
    });
    res=await request(mf,'/api/raw/sources');
    assert.equal(res.status,404); // importer falls back to legacy-only ingestion
    assert.equal((await res.json() as {migrationRequired:boolean}).migrationRequired,true);
    res=await post(mf,'/api/raw-import/begin',{provider:'AWS',digest:'a'.repeat(64),expectedRows:2});
    assert.equal(res.status,409);
    res=await request(mf,'/api/prices');
    assert.equal(res.status,200);
    assert.deepEqual((await res.json() as {offers:unknown[]}).offers,[]);
  }finally {await mf.dispose();}
});

test('Worker native D1 raw import lifecycle, cutover, ETags and source preservation', async () => {
  const mf=new Miniflare({
    modules:true,
    script:readFileSync('dist/worker.mjs','utf8'),
    compatibilityDate:'2026-08-06',
    d1Databases:{DB:'cloud-ci-rank-raw-test'},
    bindings:{IMPORT_TOKEN:'secret',READ_KEEPER_SNAPSHOTS:'1'}
  });
  try {
    const db=await mf.getD1Database('DB');
    const migration = readFileSync('migrations/0006_keeper_snapshots.sql', 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) {
      const sql = statement.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim();
      if (sql) await db.prepare(sql).run();
    }
    let res=await request(mf,'/api/raw/status');
    assert.equal(res.status,200);
    assert.equal((await res.json() as {ready:boolean}).ready,false);
    assert.equal((await post(mf,'/api/raw-import/begin',{provider:'AWS',digest:'a'.repeat(64),expectedRows:2},'wrong')).status,401);
    // A complete batch containing only raw documents is not a viable
    // published snapshot: the public view requires materialized offers.
    const bad=await post(mf,'/api/raw-import/begin',{
      provider:'AWS',digest:'f'.repeat(64),expectedRows:1
    });
    const badId=(await bad.json() as {batchId:string}).batchId;
    assert.equal((await post(mf,'/api/raw-import/chunk',{
      batchId:badId,offset:0,docs:[{kind:'raw',...rawDoc('AWS',0)}]
    })).status,200);
    const badCommit=await post(mf,'/api/raw-import/commit',{batchId:badId});
    assert.equal(badCommit.status,409);

    const all:KeeperRawDocument[]=[];
    for(const vendor of KEEPER_VENDORS) {
      const data=vendor==='AWS'?[rawDoc(vendor,0),rawDoc(vendor,1)]:[rawDoc(vendor,0)];
      all.push(...data);
      const derived=offersFromKeeperRaw(data);
      const entries=[...data.map(d=>({...d,kind:'raw' as const})),...derived.map(offer=>({kind:'offer' as const,offer}))];
      res=await post(mf,'/api/raw-import/begin',{provider:vendor,digest:(vendor==='AWS'?'a':'b').repeat(64),expectedRows:entries.length});
      assert.equal(res.status,200);
      const begin=await res.json() as {status:string;batchId:string};
      assert.equal(begin.status,'upload');
      if(vendor==='AWS') {
        res=await post(mf,'/api/raw-import/commit',{batchId:begin.batchId});
        assert.equal(res.status,409);
        assert.deepEqual((await res.json() as {actual:number}).actual,0);
      }
      res=await post(mf,'/api/raw-import/chunk',{batchId:begin.batchId,offset:0,docs:entries});
      assert.equal(res.status,200,await res.text());
      // exact retries and changed-content conflicts
      res=await post(mf,'/api/raw-import/chunk',{batchId:begin.batchId,offset:0,docs:entries});
      assert.equal(res.status,200);
      assert.equal((await res.json() as {duplicates:number}).duplicates,entries.length);
      if(vendor==='AWS') {
        res=await post(mf,'/api/raw-import/chunk',{batchId:begin.batchId,offset:0,
          docs:[{...data[0],kind:'raw',raw:{...data[0].raw,min_price_spot:0.99}}]});
        assert.equal(res.status,409);
        res=await post(mf,'/api/raw-import/chunk',{batchId:begin.batchId,offset:0,
          docs:[{...data[0],kind:'raw',raw:{...data[0].raw,vendor_id:'gcp'}}]});
        assert.equal(res.status,400);
      }
      res=await post(mf,'/api/raw-import/commit',{batchId:begin.batchId});
      const committed = await res.json() as {count:number};
      assert.equal(res.status,200,JSON.stringify(committed));
      assert.equal(committed.count,entries.length);
      res=await post(mf,'/api/raw-import/begin',{provider:vendor,digest:(vendor==='AWS'?'a':'b').repeat(64),expectedRows:entries.length});
      assert.equal((await res.json() as {status:string}).status,'unchanged');
    }
    res=await request(mf,'/api/raw/status');
    assert.equal((await res.json() as {ready:boolean}).ready,true);
    const price=await request(mf,'/api/prices');
    assert.equal(price.status,200);
    const etag=price.headers.get('etag');
    assert.ok(etag);
    const json=await price.json() as {offers: unknown[];providers:Record<string,unknown>};
    const sorted = (value: unknown[]) => value.map(v => JSON.stringify(v)).sort();
    assert.deepEqual(sorted(json.offers), sorted(offersFromKeeperRaw(all)));
    assert.equal(Object.keys(json.providers).length,KEEPER_VENDORS.length);
    assert.equal((await request(mf,'/api/prices',{headers:{'If-None-Match':etag!}})).status,304);
    assert.equal((await request(mf,'/api/raw/prices')).status,401);
    assert.equal((await request(mf,'/api/raw/prices',{headers:{authorization:'Bearer secret'}})).status,200);
    const source = await (await request(mf,'/api/raw/sources')).json() as Record<string,{batchId:string}>;
    const oldAwsBatch = source.AWS.batchId;
    res=await post(mf,'/api/raw-import/prune',{batchId:oldAwsBatch});
    assert.equal(res.status,409); // cannot prune active generation
    res=await post(mf,'/api/raw-import/begin',{provider:'AWS',digest:'c'.repeat(64),expectedRows:2});
    const nextBatch=(await res.json() as {batchId:string}).batchId;
    res=await post(mf,'/api/raw-import/chunk',{batchId:nextBatch,offset:0,docs:[{...rawDoc('AWS',1),kind:'raw'},{kind:'offer',offer:offersFromKeeperRaw([rawDoc('AWS',1)])[0]}]});
    assert.equal(res.status,200);
    assert.equal((await request(mf,'/api/prices',{headers:{'If-None-Match':etag!}})).status,304);
    res=await post(mf,'/api/raw-import/commit',{batchId:nextBatch});
    assert.equal(res.status,200);
    assert.equal((await res.json() as {previousBatchId:string}).previousBatchId,oldAwsBatch);
    res=await post(mf,'/api/raw-import/status',{batchId:oldAwsBatch});
    assert.equal(res.status,200);
    assert.equal((await res.json() as {count:number}).count,6);
    res=await post(mf,'/api/raw-import/prune',{batchId:oldAwsBatch});
    assert.equal(res.status,200);
    assert.equal((await res.json() as {count:number}).count,6);
    assert.equal((await request(mf,'/api/prices')).status,200);
    const raw=await db.prepare("SELECT data FROM keeper_documents WHERE json_extract(data, '$.json.value.raw.server_id') = ?")
      .bind('AWS-1').first<{data:string}>();
    assert.ok(raw?.data);
    const stored=JSON.parse(raw!.data);
    assert.deepEqual(stored.json.value.raw.unknown_future_attribute,{foo:['bar'],sourceVersion:12});
    const legacy=await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'instances'").first();
    assert.equal(legacy,null); // additive migration does not create or drop legacy tables
  }finally {await mf.dispose();}
});
