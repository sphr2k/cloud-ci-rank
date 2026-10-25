export type Provider='AWS'|'GCP'|'AZURE'|'HCLOUD'|'OVH'|'UPCLOUD'|'VULTR'|'ALICLOUD';
export type Geography='eu'|'us'|'global';
export type PurchaseModel='Spot'|'On-Demand';
import { BUILDKITE_AMI_REGION_SET, countryFromRegionLabel, type RegionFilter } from './regions';
export type RankingMetric='allcore'|'nominal';
export interface Offer {
 provider:Provider;instance:string;family:string;arch:string;processor:string;
 vcpu:number;ram:number;model:PurchaseModel;hour_usd:number;region:string;geo:Geography;
 source:string;evidence:string;asof:string;data_class:string;interruption:string|null;
 benchAll:number|null;benchSingle:number|null;
 regionId?:string|null;countryCode?:string|null;
}
export interface DataEnvelope {
 updatedAt:string;
 providers:Partial<Record<Provider,{checkedAt:string;changedAt:string;records:number;error?:string}>>;
 offers:Offer[];
}
export const capacityUnits=(x:Offer)=>Math.min(x.vcpu,x.ram/2);
export const score=(x:Offer)=>x.hour_usd/capacityUnits(x);
export const memoryFactor=(x:Offer)=>Math.min(1,x.ram/(2*x.vcpu));
export const throughputPerDollar=(x:Offer)=>x.benchAll===null||x.benchAll<=0?null:x.benchAll*memoryFactor(x)/x.hour_usd;
export function bestByGeo(rows:Iterable<Offer>):Offer[]{
 const best=new Map<string,Offer>();
 for(const x of rows){
  const k=[x.provider,x.family||x.instance,x.model,x.arch,x.geo,x.regionId??x.countryCode??x.geo,x.vcpu,x.ram].join('|');
  const prior=best.get(k);
  if(!prior||score(x)<score(prior)||(score(x)===score(prior)&&x.hour_usd<prior.hour_usd))best.set(k,x);
 }
 return [...best.values()];
}
export interface Selection {eu:boolean;us:boolean;maxVcpu:number;metric?:RankingMetric;regionFilter?:RegionFilter;arch?:'all'|'ARM64'|'x86-64'}
const better=(a:Offer,b:Offer,metric:RankingMetric):boolean=>{
 if(metric==='allcore'){
  const aa=throughputPerDollar(a),bb=throughputPerDollar(b);
  if(aa!==null||bb!==null)return aa!==null&&(bb===null||aa>bb);
 }
 return score(a)<score(b)||(score(a)===score(b)&&a.hour_usd<b.hour_usd);
};
export function ranking(rows:Iterable<Offer>,s:Selection):Offer[]{
 const best=new Map<string,Offer>(),metric=s.metric||'allcore';
 for(const x of rows){
  if(x.vcpu>s.maxVcpu)continue;
  if(s.arch&&s.arch!=='all'&&x.arch!==s.arch)continue;
  const filter=s.regionFilter??'all';
  const country=x.countryCode??countryFromRegionLabel(x.region);
  if(filter==='buildkite' && !(x.provider==='AWS'&&x.regionId&&BUILDKITE_AMI_REGION_SET.has(x.regionId)))continue;
  if(filter.startsWith('aws:') && !(x.provider==='AWS'&&x.regionId===filter.slice(4)))continue;
  if(filter.startsWith('country:') && country!==filter.slice(8))continue;
  if(!(x.geo==='global'||(x.geo==='eu'&&s.eu)||(x.geo==='us'&&s.us)))continue;
  const k=[x.provider,x.family||x.instance,x.model,x.arch].join('|');
  const prior=best.get(k);
  if(!prior||better(x,prior,metric))best.set(k,x);
 }
 return [...best.values()].sort((a,b)=>{
  if(metric==='allcore'){
   const aa=throughputPerDollar(a),bb=throughputPerDollar(b);
   if(aa!==null&&bb!==null&&aa!==bb)return bb-aa;
   if(aa!==null)return -1;
   if(bb!==null)return 1;
  }
  return score(a)-score(b)||a.hour_usd-b.hour_usd||a.instance.localeCompare(b.instance);
 });
}

/** Retain only candidates that can win a UI selection (8..64 max vCPU,
 * either throughput/$ or nominal unit price). Preserves both metrics exactly. */
export function compactCandidates(rows:Iterable<Offer>):Offer[]{
 const groups=new Map<string,Offer[]>();
 for(const x of rows){
  const key=[x.provider,x.family||x.instance,x.model,x.arch,x.geo,x.regionId??x.countryCode??x.geo].join('|');
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key)!.push(x);
 }
 const kept=new Map<string,Offer>();
 for(const options of groups.values()){
  for(const cap of [8,16,24,32,48,64]){
   const fit=options.filter(x=>x.vcpu<=cap);
   if(!fit.length)continue;
   for(const metric of ['allcore','nominal'] as const){
    const selection=ranking(fit,{eu:true,us:true,maxVcpu:cap,metric})[0];
    if(selection){
     const key=[selection.provider,selection.instance,selection.model,selection.arch,selection.geo,selection.region,selection.vcpu,selection.ram].join('|');
     kept.set(key,selection);
    }
   }
  }
 }
 return [...kept.values()];
}
