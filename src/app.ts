import { ranking, score, throughputPerDollar, type DataEnvelope, type Offer, type RankingMetric } from './pricing';
import { countryFromRegionLabel, type RegionFilter } from './regions';
const $=<T extends HTMLElement=HTMLElement>(id:string):T=>{
 const element=document.getElementById(id);
 if(!element)throw new Error('Missing element #'+id);
 return element as T;
};
const state:{eu:boolean;us:boolean;maxVcpu:number;metric:RankingMetric;regionFilter:RegionFilter;arch:'all'|'ARM64'|'x86-64';limit:number;sorted:Offer[]}={
 eu:true,us:true,maxVcpu:16,metric:'allcore',regionFilter:'all',arch:'all',limit:100,sorted:[]
};
let offers:Offer[]=[];
const money=(n:number,p=5)=>'$'+n.toFixed(p);
const nice=(n:number)=>n.toLocaleString('de-DE');
const fmtBench=(n:number|null)=>n===null?'–':nice(Math.round(n));
const metricValue=(x:Offer)=>state.metric==='allcore'?throughputPerDollar(x):score(x);
const cols=['provider','instance','processor','arch','model','region','region_id','country_code','geo','vcpu','ram','hour_usd','per_unit_hour_usd','bench_all','bench_single','allcore_per_usd','source','evidence','asof','data_class'] as const;
const add=(parent:HTMLElement,tag:string,value?:string|number,cls?:string):HTMLElement=>{
 const element=document.createElement(tag);
 if(value!==undefined)element.textContent=String(value);
 if(cls)element.className=cls;
 parent.append(element);return element;
};
function rowElement(x:Offer,i:number,best:number):HTMLTableRowElement{
 const tr=document.createElement('tr');tr.id='offer-'+i;
 add(tr,'td',String(i+1).padStart(2,'0'),'num rank');
 const cell=add(tr,'td');add(cell,'span',x.provider,'provider '+x.provider.toLowerCase());
 const inst=add(tr,'td',undefined,'instance');
 const a=add(inst,'a',x.instance) as HTMLAnchorElement;
 a.href=x.source;a.target='_blank';a.rel='noopener noreferrer';
 add(inst,'div',x.processor||'Unbekannter Prozessor','sub');
 add(tr,'td',x.arch,'arch');
 const tier=add(tr,'td');add(tier,'span',x.model,'pill '+(x.model==='Spot'?'spot':'ondemand'));
 add(tr,'td',x.vcpu,'num');add(tr,'td',x.ram,'num');
 const metric=add(tr,'td',undefined,'num'),value=metricValue(x);
 add(metric,'div',value===null?'Keine Messung':state.metric==='allcore'?nice(Math.round(value)):money(value),'good');
 if(value!==null){
  const bar=add(metric,'span',undefined,'bar'),part=add(bar,'i');
  part.style.width=(state.metric==='allcore'?Math.max(2,100*value/best):Math.max(2,100*best/value)).toFixed(1)+'%';
 }
 add(tr,'td',money(score(x)),'num');
 add(tr,'td',fmtBench(x.benchAll),'num');
 add(tr,'td',fmtBench(x.benchSingle),'num');
 add(tr,'td',money(x.hour_usd,4),'num');
 const place=add(tr,'td');add(place,'div',x.region,'region-label');
 add(place,'div',x.regionId?'AWS-Regionsminimum; AZ ungeprüft':'Länderminimum; Zone ungeprüft','sub');
 return tr;
}
function renderLeaders(rows:Offer[]){
 const fragment=document.createDocumentFragment();
 for(const provider of ['AWS','GCP','AZURE','HCLOUD','OVH','UPCLOUD','VULTR','ALICLOUD']){
  const index=rows.findIndex(x=>x.provider===provider);
  if(index<0)continue;
  const x=rows[index],card=document.createElement('button');card.type='button';card.className='leader';
  const head=add(card,'div',undefined,'leader-head');
  add(head,'span',provider,'provider '+provider.toLowerCase());
  add(head,'span','Rang '+(index+1),'leader-rank');
  const price=add(card,'div',undefined,'leader-price'),v=metricValue(x);
  add(price,'span',v===null?'–':state.metric==='allcore'?nice(Math.round(v)):money(v));
  add(price,'small',state.metric==='allcore'?' Ops/s pro USD/h':' USD/Einheit·h');
  add(card,'div',x.instance+' · '+x.arch,'leader-vm');
  add(card,'div',x.model+' · '+x.vcpu+' vCPU / '+nice(Math.round(x.ram))+' GiB','leader-note');
  add(card,'div',x.region,'leader-region');
  card.addEventListener('click',()=>{
   if(state.limit<index+1){state.limit=Math.ceil((index+1)/100)*100;render();}
   document.getElementById('offer-'+index)?.scrollIntoView({behavior:'smooth',block:'center'});
  });
  fragment.append(card);
 }
 $('provider-leaders').replaceChildren(fragment);
}
const countryNames=new Intl.DisplayNames(['de'],{type:'region'});
function populateRegions(){
 const select=$<HTMLSelectElement>('region-filter');
 const countries=new Set<string>(),aws=new Map<string,string>();
 for(const offer of offers){
  const country=offer.countryCode??countryFromRegionLabel(offer.region);
  if(country)countries.add(country);
  if(offer.provider==='AWS'&&offer.regionId)aws.set(offer.regionId,offer.region);
 }
 const initial=(new Option('Alle Regionen','all'));
 select.replaceChildren(initial,new Option('AWS · Buildkite-AMI-Regionen','buildkite'));
 const byCountry=document.createElement('optgroup');byCountry.label='Länder · alle Anbieter';
 for(const c of [...countries].sort((a,b)=>String(countryNames.of(a)).localeCompare(String(countryNames.of(b)),'de'))){
  byCountry.append(new Option((countryNames.of(c)||c)+' ('+c+')','country:'+c));
 }
 select.append(byCountry);
 const byRegion=document.createElement('optgroup');byRegion.label='AWS · einzelne Regionen';
 for(const [id,label] of [...aws].sort(([a],[b])=>a.localeCompare(b))){
  byRegion.append(new Option(label,'aws:'+id));
 }
 select.append(byRegion);
 if(!Array.from(select.options).some(opt=>opt.value===state.regionFilter))state.regionFilter='all';
 select.value=state.regionFilter;
}
function render(){
 $('toggle-eu').setAttribute('aria-pressed',String(state.eu));
 $('toggle-us').setAttribute('aria-pressed',String(state.us));
 $<HTMLSelectElement>('max-vcpu').value=String(state.maxVcpu);
 $<HTMLSelectElement>('ranking-metric').value=state.metric;
 $<HTMLSelectElement>('region-filter').value=state.regionFilter;
 $<HTMLSelectElement>('arch-filter').value=state.arch;
 const geographicScope=state.eu&&state.us?'Europa + USA':state.eu?'Nur Europa':'Nur USA';
 const place=$<HTMLSelectElement>('region-filter').selectedOptions[0]?.textContent;
 $('scope-text').textContent=state.regionFilter==='all'?geographicScope:(place||geographicScope);
 state.sorted=ranking(offers,state);
 const rows=state.sorted,first=rows[0],value=first?metricValue(first):null;
 $('best').textContent=value===null?'–':state.metric==='allcore'?nice(Math.round(value)):money(value);
 $('best-name').textContent=first?first.provider+' · '+first.instance+' · '+first.region:'Keine Daten';
 $('count').textContent=nice(rows.length);
 $('count-foot').textContent=[...new Set(rows.map(x=>x.provider))].join(' · ');
 $('spot-count').textContent=nice(rows.filter(x=>x.model==='Spot').length);
 $('rank-count').textContent='· '+nice(rows.length)+' Einträge';
 renderLeaders(rows);
 const fragment=document.createDocumentFragment(),base=first?(metricValue(first)??1):1;
 rows.slice(0,state.limit).forEach((x,i)=>fragment.appendChild(rowElement(x,i,base)));
 $('results').replaceChildren(fragment);
 $<HTMLButtonElement>('more').hidden=rows.length<=state.limit;
 $('more').textContent='Weitere '+nice(Math.min(100,rows.length-state.limit))+' Angebote anzeigen';
}
for(const geo of ['eu','us'] as const){
 $('toggle-'+geo).addEventListener('click',()=>{
  if(state[geo]&&!state[geo==='eu'?'us':'eu'])return;
  state[geo]=!state[geo];state.limit=100;render();
 });
}
$<HTMLSelectElement>('max-vcpu').addEventListener('change',event=>{
 state.maxVcpu=Number((event.target as HTMLSelectElement).value);
 state.limit=100;render();
});
$<HTMLSelectElement>('region-filter').addEventListener('change',event=>{
 state.regionFilter=(event.target as HTMLSelectElement).value;
 if(state.regionFilter==='buildkite'){state.eu=true;state.us=true;}
 else if(state.regionFilter!=='all'){
  const chosen=offers.find(x=>state.regionFilter.startsWith('country:')
    ? (x.countryCode??countryFromRegionLabel(x.region))===state.regionFilter.slice(8)
    : x.provider==='AWS'&&x.regionId===state.regionFilter.slice(4));
  if(chosen){state.eu=chosen.geo==='eu';state.us=chosen.geo==='us';}
 }
 state.limit=100;render();
});
$<HTMLSelectElement>('arch-filter').addEventListener('change',event=>{
 state.arch=(event.target as HTMLSelectElement).value as typeof state.arch;
 state.limit=100;render();
});
$<HTMLSelectElement>('ranking-metric').addEventListener('change',event=>{
 state.metric=(event.target as HTMLSelectElement).value as RankingMetric;
 state.limit=100;render();
});
$('more').addEventListener('click',()=>{state.limit+=100;render();});
$('export').addEventListener('click',()=>{
 const quote=(v:unknown)=>'"'+String(v??'').replaceAll('"','""')+'"';
 const csv=[cols.join(','),...state.sorted.map(x=>cols.map(k=>quote(
  k==='per_unit_hour_usd'?score(x):k==='bench_all'?x.benchAll:k==='bench_single'?x.benchSingle:
  k==='allcore_per_usd'?throughputPerDollar(x):k==='region_id'?x.regionId:k==='country_code'?x.countryCode:x[k as keyof Offer]
 )).join(','))];
 const url=URL.createObjectURL(new Blob([csv.join('\r\n')],{type:'text/csv;charset=utf-8'}));
 const link=document.createElement('a');link.href=url;link.download='cloud-ci-ranking.csv';
 document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
async function main(){
 try{
  const response=await fetch('/api/prices',{cache:'no-store'});
  if(!response.ok)throw new Error('HTTP '+response.status);
  const result=await response.json() as DataEnvelope;
  offers=result.offers.filter(x=>x.data_class==='keeper'&&['AWS','GCP','AZURE','HCLOUD','OVH','UPCLOUD','VULTR','ALICLOUD'].includes(x.provider));
  populateRegions();
  $('data-warning').textContent=offers.length?'Keeper-Import vom '+result.updatedAt+'; Benchmarks stress_ng:bestn/best1.':'Noch keine Keeper-Daten importiert.';
 }catch(e){
  $('data-warning').textContent='Preisdaten nicht verfügbar: '+String(e);
 }
 render();
}
void main();
