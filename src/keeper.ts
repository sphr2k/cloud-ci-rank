/** Spare Cores Navigator API, source data CC BY-SA 4.0. */
import { bestByGeo, compactCandidates, type Offer } from './pricing';
export const KEEPER_API='https://keeper.sparecores.net';
export const KEEPER_VENDORS=['AWS','GCP','AZURE','HCLOUD','OVH','UPCLOUD','VULTR','ALICLOUD'] as const;
export type KeeperVendor=typeof KEEPER_VENDORS[number];
export const COUNTRIES=['AT','BE','CH','DE','DK','ES','FI','FR','GB','IE','IT','NL','NO','PL','SE','US'] as const;
const vendorIds:Record<KeeperVendor,string>={AWS:'aws',GCP:'gcp',AZURE:'azure',HCLOUD:'hcloud',OVH:'ovh',UPCLOUD:'upcloud',VULTR:'vultr',ALICLOUD:'alicloud'};
interface KeeperServer {
 vendor_id:string;server_id:string;name:string;display_name?:string;family?:string|null;series?:string|null;
 vcpus:number;memory_amount:number;cpu_architecture?:string|null;cpu_manufacturer?:string|null;
 cpu_family?:string|null;cpu_model?:string|null;accelerator_count?:number;
 selected_benchmark_score?:number|null;min_price_spot?:number|null;min_price_ondemand?:number|null;
 observed_at?:string;status?:string;
}
export interface KeeperRegion { regionId:string; name:string; country:string }
export function keeperRows(data:unknown,country:string,single:Map<string,number>,awsRegion?:KeeperRegion):Offer[]{
 if(!Array.isArray(data))throw new Error('Keeper /servers must return an array');
 const geo=country==='US'?'us':'eu';
 const label=new Intl.DisplayNames(['de'],{type:'region'}).of(country)||country;
 const result:Offer[]=[];
 for(const candidate of data){
  if(!candidate||typeof candidate!=='object')continue;
  const x=candidate as KeeperServer,provider=KEEPER_VENDORS.find(v=>vendorIds[v]===x.vendor_id);
  if(!provider)continue;
  const vcpu=Number(x.vcpus),ram=Number(x.memory_amount)/1024;
  if(!Number.isInteger(vcpu)||vcpu<8||vcpu>64||!Number.isFinite(ram)||ram<16||Number(x.accelerator_count||0)>0)continue;
  if(x.status&&x.status!=='active')continue;
  const n=Number(x.selected_benchmark_score);
  const allcore=Number.isFinite(n)&&n>0?n:null;
  const singlecore=single.get(x.vendor_id+':'+x.server_id)??null;
  const cpu=String(x.cpu_architecture||'unknown').toLowerCase();
  const arch=cpu.includes('arm')?'ARM64':cpu.includes('x86')?'x86-64':'unknown';
  const family=String(x.family||x.series||x.name);
  const instance=String(x.display_name||x.name||x.server_id);
  const processor=[x.cpu_manufacturer,x.cpu_family,x.cpu_model].filter(Boolean).join(' ')||'CPU not specified';
  for(const [model,value] of [['Spot',x.min_price_spot],['On-Demand',x.min_price_ondemand]] as const){
   const hourly=Number(value);
   if(!Number.isFinite(hourly)||hourly<=0)continue;
   result.push({provider,instance,family,arch,processor,vcpu,ram,model,hour_usd:hourly,geo,
     region:awsRegion?awsRegion.name+' ('+awsRegion.regionId+')':label+' ('+country+')',
     regionId:awsRegion?.regionId??null,countryCode:country,source:KEEPER_API+'/servers',
     evidence:'Spare Cores '+(awsRegion?'AWS region-minimum':'country-minimum')+' '+model+' price (no capacity guarantee)',
     asof:String(x.observed_at||'').slice(0,10),data_class:'keeper',interruption:null,
     benchAll:allcore,benchSingle:singlecore});
  }
 }
 return result;
}
async function keeperGet(fetcher:typeof fetch,url:string):Promise<unknown>{
 for(let attempt=0;attempt<4;attempt++){
  const res=await fetcher(url,{headers:{accept:'application/json','user-agent':'cloud-ci-rank/1.1'}});
  if(res.ok)return res.json();
  if((res.status===429||res.status===503)&&attempt<3){
   const retry=res.headers.get('Retry-After');
   if(res.status===429&&!retry)throw new Error('Keeper 429, no Retry-After: not retryable');
   const ms=retry?Number(retry)*1000:1500*2**attempt;
   await new Promise(r=>setTimeout(r,Number.isFinite(ms)?Math.max(1500,Math.min(ms,65000)):2500));
   continue;
  }
  throw new Error('Keeper HTTP '+res.status+' on '+new URL(url).pathname);
 }
 throw new Error('Keeper API retry limit reached');
}
export async function fetchKeeperAll(fetcher:typeof fetch=fetch):Promise<Record<KeeperVendor,Offer[]>>{
 const singleUrl=new URL('/servers',KEEPER_API);
 for(const [key,value] of Object.entries({vcpus_min:'8',vcpus_max:'64',memory_min:'16',gpu_max:'0',benchmark_id:'stress_ng:best1',limit:'-1'}))
  singleUrl.searchParams.set(key,value);
 const singleRows=await keeperGet(fetcher,singleUrl.toString());
 if(!Array.isArray(singleRows)||singleRows.length<100)throw new Error('Keeper single-core catalog incomplete');
 const single=new Map<string,number>();
 for(const r of singleRows){
  const x=r as KeeperServer,s=Number(x.selected_benchmark_score);
  if(Number.isFinite(s)&&s>0)single.set(x.vendor_id+':'+x.server_id,s);
 }
 const all:Offer[]=[];
 // Country-minimum prices are retained for vendors without exact region data.
 // Public Keeper permits one AWS region per /servers query. Extra ~50 credits
 // remain below the documented 300 credits/minute fair-use budget.
 const catalog=await keeperGet(fetcher,KEEPER_API+'/table/region');
 if(!Array.isArray(catalog))throw new Error('Keeper region catalog must be an array');
 const awsRegions:KeeperRegion[]=catalog.filter((x):x is Record<string,unknown>=>!!x&&typeof x==='object')
   .filter(x=>x.vendor_id==='aws'&&x.status==='active'&&COUNTRIES.includes(x.country_id as typeof COUNTRIES[number]))
   .map(x=>({regionId:String(x.region_id),name:String(x.display_name||x.name||x.region_id),country:String(x.country_id)}))
   .sort((a,b)=>a.regionId.localeCompare(b.regionId));
 if(!awsRegions.length)throw new Error('Keeper returned no active AWS regions');
 for(let i=0;i<COUNTRIES.length;i+=2){
  const batch=await Promise.all(COUNTRIES.slice(i,i+2).map(async country=>{
   const url=new URL('/servers',KEEPER_API);
   for(const [key,value] of Object.entries({countries:country,vcpus_min:'8',vcpus_max:'64',memory_min:'16',gpu_max:'0',benchmark_id:'stress_ng:bestn',best_price_allocation:'ANY',limit:'-1'}))
    url.searchParams.set(key,value);
   const rows=await keeperGet(fetcher,url.toString());
   return keeperRows(rows,country,single);
  }));
  for(const rows of batch)all.push(...rows.filter(x=>x.provider!=='AWS'));
 }
 // AWS quotes are now exact region-scoped minimum prices, not country-wide.
 for(let i=0;i<awsRegions.length;i+=2){
  const batch=await Promise.all(awsRegions.slice(i,i+2).map(async region=>{
   const url=new URL('/servers',KEEPER_API);
   for(const [key,value] of Object.entries({vendor:'aws',regions:region.regionId,vcpus_min:'8',vcpus_max:'64',memory_min:'16',gpu_max:'0',benchmark_id:'stress_ng:bestn',best_price_allocation:'ANY',limit:'-1'}))
    url.searchParams.set(key,value);
   const rows=await keeperGet(fetcher,url.toString());
   if(!Array.isArray(rows))throw new Error('Keeper AWS '+region.regionId+' response must be an array');
   return keeperRows(rows,region.country,single,region);
  }));
  for(const rows of batch)all.push(...rows);
 }
 const compact=compactCandidates(bestByGeo(all));
 const byVendor=Object.fromEntries(KEEPER_VENDORS.map(p=>[p,compact.filter(x=>x.provider===p)])) as Record<KeeperVendor,Offer[]>;
 for(const [vendor,rows] of Object.entries(byVendor))if(!rows.length)throw new Error('Keeper missing vendor '+vendor);
 return byVendor;
}
