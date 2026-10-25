import { createHash } from 'node:crypto';
import { fetchKeeperAll, KEEPER_VENDORS } from '../src/keeper';
import type { Offer } from '../src/pricing';

const endpoint=process.env.CLOUD_CI_RANK_URL?.replace(/\/+$/,'');
const token=process.env.CLOUD_CI_IMPORT_TOKEN;
if(!endpoint||!token)throw new Error('CLOUD_CI_RANK_URL and CLOUD_CI_IMPORT_TOKEN required');
async function get<T>(path:string):Promise<T>{
 const res=await fetch(endpoint+path);
 if(!res.ok)throw new Error('GET '+path+': HTTP '+res.status);
 return res.json() as Promise<T>;
}
async function post<T>(path:string,data:unknown):Promise<T>{
 for(let attempt=0;attempt<3;attempt++){
  const res=await fetch(endpoint+path,{method:'POST',
   headers:{'content-type':'application/json','authorization':'Bearer '+token},
   body:JSON.stringify(data)});
  if(res.ok)return res.json() as Promise<T>;
  const detail=(await res.text()).slice(0,400);
  if(res.status>=400&&res.status<500&&res.status!==429)throw new Error('POST '+path+': HTTP '+res.status+' '+detail);
  if(attempt===2)throw new Error('POST '+path+': HTTP '+res.status+' '+detail);
  await new Promise(r=>setTimeout(r,1500*(attempt+1)));
 }
 throw new Error('unreachable');
}
export function digestOffers(offers:Offer[]):string{
 const normalized=offers.map(x=>[
  x.instance,x.family,x.arch,x.processor,x.vcpu,x.ram,x.model,
  x.hour_usd,x.region,x.regionId,x.countryCode,x.geo,x.benchAll,x.benchSingle
 ]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
async function main(){
 const old=await get<Record<string,{digest:string|null}>>('/api/sources');
 const grouped=await fetchKeeperAll();
 for(const vendor of KEEPER_VENDORS){
  const offers=grouped[vendor],digest=digestOffers(offers);
  if(old[vendor]?.digest===digest){console.log(vendor,'unchanged, no D1 writes');continue;}
  const start=Date.now();
  const begin=await post<{status:'unchanged'|'upload';batchId?:string}>('/api/import/begin',{
   provider:vendor,digest,etag:null,expectedRows:offers.length
  });
  if(begin.status==='unchanged'){console.log(vendor,'already published');continue;}
  if(!begin.batchId)throw new Error(vendor+' missing batch');
  for(let offset=0;offset<offers.length;offset+=10){
   await post('/api/import/chunk',{batchId:begin.batchId,offset,offers:offers.slice(offset,offset+10)});
  }
  const result=await post<{status:string;count:number}>('/api/import/commit',{batchId:begin.batchId});
  if(result.status!=='committed'||result.count!==offers.length)throw new Error(vendor+' commit failed');
  console.log(vendor,'published',result.count,'rows; time',Date.now()-start,'ms');
 }
}
await main();
