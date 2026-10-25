import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { serializeDocument } from 'supersqlite';
import { KEEPER_VENDORS, keeperRows, type KeeperVendor } from '../src/keeper';
import { ranking, type Offer } from '../src/pricing';
import { digestOffers, offerChunks, snapshotDigest, canonicalJson } from '../scripts/offer-utils';

const ids: Record<KeeperVendor,string> = {
  AWS:'aws',GCP:'gcp',AZURE:'azure',HCLOUD:'hcloud',OVH:'ovh',
  UPCLOUD:'upcloud',VULTR:'vultr',ALICLOUD:'alicloud'
};
function offers(provider: KeeperVendor, index=0): Offer[] {
  return keeperRows([{
    vendor_id:ids[provider],server_id:`${provider}-${index}`,name:`${provider}-${index}`,
    family:'family',vcpus:16,memory_amount:32768,cpu_architecture:index?'x86_64':'arm64',
    cpu_model:'CPU',min_price_spot:.2+index*.01,min_price_ondemand:.4+index*.01,
    selected_benchmark_score:40000,observed_at:'2026-10-25'
  }],index?'US':'DE',new Map([[ids[provider]+':'+provider+'-'+index,2500]]),
  provider==='AWS'?{regionId:index?'us-east-1':'eu-central-1',name:index?'N. Virginia':'Frankfurt',country:index?'US':'DE'}:undefined);
}
const request=(mf:Miniflare,path:string,init:Parameters<Miniflare['dispatchFetch']>[1]={})=>
  mf.dispatchFetch('https://test.invalid'+path,init);
const post=(mf:Miniflare,path:string,body:unknown,token='secret')=>request(mf,path,{
  method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)
});
async function setup(dbName:string,withSchema=true){
  const mf=new Miniflare({modules:true,script:readFileSync('dist/worker.mjs','utf8'),
    compatibilityDate:'2026-08-06',d1Databases:{DB:dbName},
    bindings:{IMPORT_TOKEN:'secret',READ_KEEPER_SNAPSHOTS:'1'}});
  const db=await mf.getD1Database('DB');
  if(withSchema){
    const migration=readFileSync('migrations/0006_keeper_snapshots.sql','utf8');
    for(const part of migration.split('--> statement-breakpoint')){
      const sql=part.split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').trim();
      if(sql)await db.prepare(sql).run();
    }
  }
  return {mf,db};
}

test('Offer-only digests track all fields but ignore object key order',()=>{
  const baseline=offers('AWS');
  const reordered=baseline.map(x=>Object.fromEntries(Object.entries(x).reverse()) as unknown as Offer);
  assert.equal(snapshotDigest(baseline),snapshotDigest(reordered));
  assert.notEqual(snapshotDigest(baseline),snapshotDigest(baseline.map(x=>({...x,arch:'x86-64'}))));
  assert.notEqual(snapshotDigest(baseline),snapshotDigest(baseline.map(x=>({...x,regionId:'eu-central-2'}))));
  assert.notEqual(snapshotDigest(baseline),snapshotDigest(baseline.map(x=>({...x,evidence:'updated evidence'}))));
  assert.ok(snapshotDigest(baseline).startsWith('offer-only-v1:'));
  assert.equal(canonicalJson(baseline[0]),canonicalJson(reordered[0]));
  assert.notEqual(digestOffers(baseline),digestOffers(baseline.map(x=>({...x,countryCode:'FR'}))));
  const many=[...baseline,...offers('GCP')];
  const chunks=offerChunks('01KABCD123456789',many);
  assert.equal(chunks.reduce((total,x)=>total+x.offers.length,0),many.length);
  const large=Array.from({length:250},(_,i)=>({...baseline[0],instance:'vm-'+i}));
  const paged=offerChunks('01KABCD123456789',large);
  assert.deepEqual(paged.map(x=>x.offset),[0,1,2]);
  assert.deepEqual(paged.flatMap(x=>x.offers),large);
  assert.ok(paged.every(x=>Buffer.byteLength(JSON.stringify({batchId:'01KABCD123456789',...x}))<=48000));
});

test('Missing snapshot schema retains legacy route and refuses staging',async()=>{
  const {mf,db}=await setup('missing-offer-snapshot',false);
  try{
    await db.prepare(`CREATE TABLE sources (provider TEXT PRIMARY KEY,etag TEXT,content_digest TEXT,active_batch TEXT,checked_at TEXT NOT NULL,changed_at TEXT NOT NULL,error TEXT)`).run();
    assert.deepEqual(await (await request(mf,'/api/snapshots/status')).json(),{
      ready:false,migrationRequired:true,present:[],missing:[...KEEPER_VENDORS]
    });
    assert.equal((await request(mf,'/api/snapshots/sources')).status,404);
    assert.equal((await request(mf,'/api/prices')).status,200);
  }finally{await mf.dispose();}
});

test('D1 Offer snapshots publish atomically, reject corruption and avoid any raw document storage',async()=>{
  const {mf,db}=await setup('offer-only-end-to-end');
  try{
    // Simulate an old, fully published mixed raw snapshot. It cannot mark the
    // new Offer-only schema ready, even if it covers the provider.
    await db.prepare(`INSERT INTO keeper_heads(namespace,batch_id,digest,checked_at,changed_at) VALUES(?,?,?,?,?)`)
      .bind('AWS','legacy-batch','legacy-raw-hash','2026-10-25','2026-10-25').run();
    assert.equal((await (await request(mf,'/api/snapshots/status')).json() as {ready:boolean}).ready,false);
    await db.prepare('DELETE FROM keeper_heads WHERE namespace=?').bind('AWS').run();
    assert.equal((await post(mf,'/api/snapshots/import/begin',{
      provider:'AWS',digest:snapshotDigest(offers('AWS')),expectedRows:1},'wrong')).status,401);

    const expected:Offer[]=[];
    for(const provider of KEEPER_VENDORS){
      const entries=provider==='AWS'?[...offers(provider),...offers(provider,1)]:offers(provider);
      expected.push(...entries);
      const digest=snapshotDigest(entries);
      let response=await post(mf,'/api/snapshots/import/begin',{
        provider,digest,expectedRows:1
      });
      assert.equal(response.status,200);
      const batchId=(await response.json() as {batchId:string}).batchId;
      if(provider==='AWS'){
        response=await post(mf,'/api/snapshots/import/commit',{batchId});
        assert.equal(response.status,409);
        assert.equal((await response.json() as {actual:number}).actual,0);
      }
      response=await post(mf,'/api/snapshots/import/chunk',{batchId,offset:0,offers:entries});
      assert.equal(response.status,200,await response.clone().text());
      response=await post(mf,'/api/snapshots/import/chunk',{batchId,offset:0,offers:entries});
      assert.equal((await response.json() as {duplicates:number}).duplicates,1);
      if(provider==='AWS'){
        response=await post(mf,'/api/snapshots/import/chunk',{
          batchId,offset:0,offers:[{...entries[0],hour_usd:.99}]});
        assert.equal(response.status,409);
        response=await post(mf,'/api/snapshots/import/chunk',{
          batchId,offset:0,offers:[{...entries[0],provider:'GCP'}]});
        assert.equal(response.status,400);
        response=await post(mf,'/api/snapshots/import/chunk',{
          batchId,offset:0,offers:[{kind:'raw',raw:{server_id:'x'}}]});
        assert.equal(response.status,400);
      }
      response=await post(mf,'/api/snapshots/import/commit',{batchId});
      assert.equal(response.status,200,await response.clone().text());
      assert.equal((await response.json() as {count:number}).count,1);
      response=await post(mf,'/api/snapshots/import/begin',{
        provider,digest,expectedRows:1
      });
      assert.equal((await response.json() as {status:string}).status,'unchanged');
    }
    const status=await (await request(mf,'/api/snapshots/status')).json() as {ready:boolean;missing:string[]};
    assert.equal(status.ready,true);
    assert.deepEqual(status.missing,[]);
    const response=await request(mf,'/api/prices');
    assert.equal(response.status,200);
    const etag=response.headers.get('etag');assert.ok(etag);
    const result=await response.json() as {offers:Offer[];providers:Record<string,unknown>};
    assert.deepEqual(result.offers.map(canonicalJson).sort(),expected.map(canonicalJson).sort());
    assert.equal(Object.keys(result.providers).length,8);
    assert.equal(ranking(result.offers,{eu:true,us:false,maxVcpu:16,arch:'ARM64',regionFilter:'buildkite'}).length,2);
    assert.equal((await request(mf,'/api/prices',{headers:{'If-None-Match':etag!}})).status,304);
    assert.equal((await request(mf,'/api/snapshots/prices')).status,401);
    assert.equal((await request(mf,'/api/snapshots/prices',{headers:{authorization:'Bearer secret'}})).status,200);
    const count=await db.prepare(`SELECT COUNT(*) AS n FROM keeper_documents WHERE json_extract(data,'$.json.value.provider') IS NOT NULL`).first<{n:number}>();
    assert.equal(count?.n,0); // Offers are held inside typed JSON pages, not individual rows
    const pages=await db.prepare(`SELECT COUNT(*) AS n FROM keeper_documents WHERE json_array_length(json_extract(data,'$.json.value.offers'))>0`).first<{n:number}>();
    assert.equal(pages?.n,8);
    const raw=await db.prepare(`SELECT COUNT(*) AS n FROM keeper_documents WHERE json_extract(data,'$.json.value.raw') IS NOT NULL`).first<{n:number}>();
    assert.equal(raw?.n,0);
    const meta=await db.prepare(`SELECT COUNT(*) AS n FROM keeper_heads WHERE digest LIKE 'offer-only-v1:%'`).first<{n:number}>();
    assert.equal(meta?.n,8);
  }finally{await mf.dispose();}
});
