import { HTML, APP } from './assets.generated';
import type { D1Database } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { eq, inArray, count } from 'drizzle-orm';
import { z } from 'zod';
import { instances, sources, imports, Instance } from './db/schema';
import type { Offer, DataEnvelope } from './pricing';
import { rawSources, rawStatus, rawPrices, rawImport } from './raw-import';

interface Env { DB: D1Database; IMPORT_TOKEN?: string; READ_KEEPER_SNAPSHOTS?: string }
const HEADER={'content-type':'application/json; charset=utf-8','cache-control':'public,max-age=120,s-maxage=300'};
const providerSchema=z.enum(['AWS','GCP','AZURE','HCLOUD','OVH','UPCLOUD','VULTR','ALICLOUD']);
const beginSchema=z.object({
  provider:providerSchema,etag:z.string().nullable().default(null),
  digest:z.string().regex(/^[a-f0-9]{64}$/),expectedRows:z.number().int().min(1).max(10000)
});
const offerSchema=z.object({
  provider:providerSchema,instance:z.string(),family:z.string(),arch:z.string(),
  processor:z.string(),vcpu:z.number().int(),ram:z.number(),model:z.enum(['Spot','On-Demand']),
  hour_usd:z.number().positive(),region:z.string(),regionId:z.string().nullable().optional(),countryCode:z.string().nullable().optional(),geo:z.enum(['eu','us','global']),
  source:z.string(),evidence:z.string(),asof:z.string(),data_class:z.string(),interruption:z.string().nullable(),benchAll:z.number().positive().nullable(),benchSingle:z.number().positive().nullable(),
});
const chunkSchema=z.object({batchId:z.string().uuid(),offset:z.number().int().nonnegative(),offers:z.array(offerSchema).min(1).max(20)});
const commitSchema=z.object({batchId:z.string().uuid()});

async function payload(request:Request):Promise<unknown>{
  if(Number(request.headers.get('Content-Length')||0)>64000)throw new Error('Payload too large');
  return request.json();
}
async function begin(env:Env,request:Request):Promise<Response>{
  const data=beginSchema.parse(await payload(request)),db=drizzle(env.DB);
  const prior=await db.select().from(sources).where(eq(sources.provider,data.provider)).get();
  if(prior?.activeBatch && prior.contentDigest===data.digest)return Response.json({status:'unchanged',provider:data.provider});
  const batchId=crypto.randomUUID();
  await db.insert(imports).values({...data,batchId,startedAt:new Date().toISOString()});
  return Response.json({status:'upload',batchId});
}
async function chunk(env:Env,request:Request):Promise<Response>{
  const data=chunkSchema.parse(await payload(request)),db=drizzle(env.DB);
  const pending=await db.select().from(imports).where(eq(imports.batchId,data.batchId)).get();
  if(!pending)return Response.json({error:'Unknown batch'},{status:404});
  if(data.offset+data.offers.length>pending.expectedRows || data.offers.some(x=>x.provider!==pending.provider))
    return Response.json({error:'Invalid import range or provider'},{status:400});
  const rows=data.offers.map((x,i)=>Instance.parse({
    id:data.batchId+':'+(data.offset+i),batchId:data.batchId,provider:x.provider,
    instance:x.instance,family:x.family,arch:x.arch,processor:x.processor,vcpu:x.vcpu,ram:x.ram,
    model:x.model,hourUsd:x.hour_usd,region:x.region,regionId:x.regionId??null,countryCode:x.countryCode??null,geo:x.geo,source:x.source,
    evidence:x.evidence,asof:x.asof,dataClass:x.data_class,interruption:x.interruption,benchAll:x.benchAll,benchSingle:x.benchSingle,
  }));
  for(let i=0;i<rows.length;i+=4)await db.insert(instances).values(rows.slice(i,i+4)).onConflictDoNothing();
  return Response.json({status:'accepted',count:rows.length});
}
async function commit(env:Env,request:Request):Promise<Response>{
  const {batchId}=commitSchema.parse(await payload(request)),db=drizzle(env.DB);
  const pending=await db.select().from(imports).where(eq(imports.batchId,batchId)).get();
  if(!pending)return Response.json({error:'Unknown batch'},{status:404});
  const [{value:actual}]=await db.select({value:count()}).from(instances).where(eq(instances.batchId,batchId));
  if(actual!==pending.expectedRows)return Response.json({error:'Incomplete batch',actual,expected:pending.expectedRows},{status:409});
  const prior=await db.select().from(sources).where(eq(sources.provider,pending.provider)).get();
  const now=new Date().toISOString();
  await db.insert(sources).values({provider:pending.provider,activeBatch:batchId,etag:pending.etag,contentDigest:pending.digest,checkedAt:now,changedAt:now,error:null})
    .onConflictDoUpdate({target:sources.provider,set:{activeBatch:batchId,etag:pending.etag,contentDigest:pending.digest,checkedAt:now,changedAt:now,error:null}});
  await db.delete(imports).where(eq(imports.batchId,batchId));
  if(prior?.activeBatch && prior.activeBatch!==batchId)await db.delete(instances).where(eq(instances.batchId,prior.activeBatch));
  return Response.json({status:'committed',provider:pending.provider,count:actual});
}
async function prices(env:Env,request:Request):Promise<Response>{
  const db=drizzle(env.DB),statuses=await db.select().from(sources).all();
  const batches=statuses.map(x=>x.activeBatch).filter((x):x is string=>!!x);
  const rows=batches.length?await db.select().from(instances).where(inArray(instances.batchId,batches)).all():[];
  const offers:Offer[]=rows.map(x=>({provider:x.provider,instance:x.instance,family:x.family,arch:x.arch,processor:x.processor,
    vcpu:x.vcpu,ram:x.ram,model:x.model,hour_usd:x.hourUsd,region:x.region,regionId:x.regionId,countryCode:x.countryCode,geo:x.geo,source:x.source,
    evidence:x.evidence,asof:x.asof,data_class:x.dataClass,interruption:x.interruption,benchAll:x.benchAll,benchSingle:x.benchSingle}));
  const data:DataEnvelope={updatedAt:statuses.map(x=>x.changedAt).sort().at(-1)||'',
    providers:Object.fromEntries(statuses.map(x=>[x.provider,{checkedAt:x.checkedAt,changedAt:x.changedAt,
      records:rows.filter(y=>y.provider===x.provider).length,...(x.error?{error:x.error}:{})}])),
    offers};
  const etag='"'+statuses.map(x=>x.provider+':'+x.activeBatch).sort().join('|')+'"';
  if(request.headers.get('If-None-Match')===etag)return new Response(null,{status:304,headers:{etag}});
  return Response.json(data,{headers:{...HEADER,etag}});
}
export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(path==='/api/prices'&&request.method==='GET'){
      if(env.READ_KEEPER_SNAPSHOTS==='1'){
        try {
          const raw = await rawPrices(env.DB, request);
          if(raw) return raw;
        } catch(error) { console.error('Raw Keeper read failed, preserving legacy prices:', error); }
      }
      return prices(env,request);
    }
    if(path==='/api/raw/sources'&&request.method==='GET')return rawSources(env.DB);
    if(path==='/api/raw/status'&&request.method==='GET')return rawStatus(env.DB);
    if(path==='/api/raw/prices'&&request.method==='GET'){
      if(!env.IMPORT_TOKEN || request.headers.get('Authorization')!=='Bearer '+env.IMPORT_TOKEN)
        return new Response('Unauthorized',{status:401});
      try { return await rawPrices(env.DB, request) ?? Response.json({error:'Raw snapshots not complete'}, {status:409}); }
      catch(error) { console.error(error); return Response.json({error:'Raw snapshot read error'}, {status:503}); }
    }
    if(path.startsWith('/api/raw-import/')&&request.method==='POST'){
      if(!env.IMPORT_TOKEN || request.headers.get('Authorization')!=='Bearer '+env.IMPORT_TOKEN)
        return new Response('Unauthorized',{status:401});
      try { return await rawImport(env.DB,path,request); }
      catch(error){ console.error(error); return Response.json({error:'Raw import internal error'}, {status:500}); }
    }
    if(path==='/api/sources'&&request.method==='GET'){
      const state=await drizzle(env.DB).select().from(sources).all();
      return Response.json(Object.fromEntries(state.map(x=>[x.provider,{etag:x.etag,digest:x.contentDigest,checkedAt:x.checkedAt,changedAt:x.changedAt}])),{headers:HEADER});
    }
    if(path==='/api/health')return Response.json({ok:true,service:'cloud-ci-rank'},{headers:HEADER});
    if(path.startsWith('/api/import/')&&request.method==='POST'){
      if(!env.IMPORT_TOKEN || request.headers.get('Authorization')!=='Bearer '+env.IMPORT_TOKEN)
        return new Response('Unauthorized',{status:401});
      try {
        if(path==='/api/import/begin')return await begin(env,request);
        if(path==='/api/import/chunk')return await chunk(env,request);
        if(path==='/api/import/commit')return await commit(env,request);
      } catch(e){
        if(e instanceof z.ZodError)return Response.json({error:'Invalid payload',issues:e.issues},{status:400});
        console.error(e);return Response.json({error:String(e)},{status:500});
      }
    }
    if(path.startsWith('/api/'))return new Response('Not Found',{status:404});
    if(request.method!=='GET')return new Response('Method Not Allowed',{status:405});
    if(path==='/'||path==='/index.html')return new Response(HTML,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'public,max-age=300'}});
    if(path==='/app.js')return new Response(APP,{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'public,max-age=300'}});
    return new Response('Not Found',{status:404});
  }
};
