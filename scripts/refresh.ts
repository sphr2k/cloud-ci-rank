import { createHash } from 'node:crypto';
import { parseOracle, parseVantage, VANTAGE } from '../src/feeds';
import type { Offer } from '../src/pricing';

const endpoint = process.env.CLOUD_CI_RANK_URL?.replace(/\/+$/, '');
const token = process.env.CLOUD_CI_IMPORT_TOKEN;
if (!endpoint || !token) throw new Error('CLOUD_CI_RANK_URL and CLOUD_CI_IMPORT_TOKEN required');
const providers = ['AWS','GCP','OCI'] as const;

async function get<T>(path:string): Promise<T> {
  const res=await fetch(endpoint+path,{headers:{'accept':'application/json'}});
  if(!res.ok)throw new Error('GET '+path+': HTTP '+res.status);
  return res.json() as Promise<T>;
}
async function post<T>(path:string, data:unknown): Promise<T> {
  let failure:unknown;
  for(let retry=0;retry<3;retry++){
    try{
      const res=await fetch(endpoint+path,{method:'POST',headers:{
        'content-type':'application/json','Authorization':'Bearer '+token},
        body:JSON.stringify(data)});
      if(!res.ok)throw new Error('POST '+path+': HTTP '+res.status+' '+(await res.text()).slice(0,350));
      return res.json() as Promise<T>;
    } catch(e) {failure=e;if(retry<2) await new Promise(r=>setTimeout(r,1000*(retry+1)));}
  }
  throw failure;
}
function digestOffers(offers:Offer[]):string {
  const normalized=offers.map(x=>[
    x.instance,x.family,x.arch,x.processor,x.vcpu,x.ram,x.model,
    x.hour_usd,x.region,x.geo,x.interruption
  ]).sort((a,b)=>String(a).localeCompare(String(b)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
const state=await get<Record<string,{etag:string|null,digest:string|null}>>('/api/sources');
for(const provider of providers) {
  const since=performance.now();
  let offers:Offer[],etag:string|null=null;
  if(provider==='OCI')offers=await parseOracle(fetch,new Date().toISOString().slice(0,10));
  else {
    const headers=new Headers();
    if(state[provider]?.etag) headers.set('If-None-Match',state[provider].etag);
    const response=await fetch(VANTAGE[provider],{headers});
    if(response.status===304){console.log(provider,'HTTP 304 not modified');continue;}
    if(!response.ok||!response.body)throw new Error(provider+' upstream HTTP '+response.status);
    etag=response.headers.get('ETag');
    offers=(await parseVantage(provider,response.body,new Date().toISOString().slice(0,10))).offers;
  }
  const digest=digestOffers(offers);
  if(state[provider]?.digest===digest){
    console.log(provider,'normalized prices unchanged, rows:',offers.length);continue;
  }
  const begin=await post<{status:'unchanged'|'upload';batchId?:string}>('/api/import/begin',{
    provider,digest,etag,expectedRows:offers.length
  });
  if(begin.status==='unchanged'){console.log(provider,'already uploaded');continue;}
  if(!begin.batchId)throw new Error(provider+' missing upload ID');
  for(let offset=0;offset<offers.length;offset+=10) {
    await post('/api/import/chunk',{batchId:begin.batchId,offset,offers:offers.slice(offset,offset+10)});
  }
  const done=await post<{status:string,count:number}>('/api/import/commit',{batchId:begin.batchId});
  if(done.status!=='committed'||done.count!==offers.length)throw new Error(provider+' incomplete commit');
  console.log(provider,'committed',done.count,'normalized offers in',Math.round(performance.now()-since),'ms');
}
