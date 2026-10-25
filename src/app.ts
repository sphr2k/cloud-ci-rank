import { ranking, score, type DataEnvelope, type Offer } from './pricing';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const item = document.getElementById(id);
  if (!item) throw new Error('Missing element #' + id);
  return item as T;
};
const state = {eu:true,us:true,maxVcpu:16,limit:100,sorted:[] as Offer[]};
let offers:Offer[] = [];
const format = (v:number, places=5) => '$' + v.toFixed(places);
const nice = (v:number) => v.toLocaleString('de-DE');
const columns = ['provider','instance','processor','arch','model','region','geo','vcpu','ram','hour_usd','per_unit_hour_usd','source','evidence','asof','data_class','interruption'] as const;
const add = (parent:HTMLElement, tag:string, value?:string|number, cls?:string):HTMLElement => {
  const item=document.createElement(tag);
  if (value !== undefined) item.textContent=String(value);
  if (cls) item.className=cls;
  parent.append(item);
  return item;
};

function createRow(x:Offer,i:number,bestScore:number):HTMLTableRowElement {
  const tr=document.createElement('tr');
  tr.id='offer-'+i;
  add(tr,'td',String(i+1).padStart(2,'0'),'num rank');
  const pv=add(tr,'td');add(pv,'span',x.provider,'provider '+x.provider.toLowerCase());
  const inst=add(tr,'td',undefined,'instance');
  const a=add(inst,'a',x.instance) as HTMLAnchorElement;
  if (x.source.startsWith('https://')) {a.href=x.source;a.target='_blank';a.rel='noopener noreferrer';}
  add(inst,'div',x.processor || 'CPU nicht spezifiziert','sub');
  add(tr,'td',x.arch,'arch');
  const model=add(tr,'td');
  add(model,'span',x.provider==='OCI' && x.model==='Spot'?'Preemptible −50%':x.model,'pill '+(x.model==='Spot'?'spot':'ondemand'));
  add(tr,'td',x.vcpu,'num');add(tr,'td',x.ram,'num');
  const cost=add(tr,'td',undefined,'num');
  add(cost,'div',format(score(x)),'good');
  const bar=add(cost,'span',undefined,'bar');
  const part=add(bar,'i') as HTMLElement;
  part.style.width=Math.max(2,Math.min(100,100*bestScore/score(x))).toFixed(1)+'%';
  add(tr,'td',format(x.hour_usd,4),'num');
  add(tr,'td',format(x.hour_usd/60,6),'num');
  const place=add(tr,'td');
  add(place,'div',x.geo==='global'?'Globaler Listenpreis':x.region,'region-label '+(x.geo==='global'?'global':''));
  if(x.geo==='global')add(place,'div','Regionale Verfügbarkeit ungeprüft','sub');
  else if(x.interruption)add(place,'div','Spot-Unterbrechungen: '+x.interruption,'sub');
  return tr;
}
function renderLeaders(rows:Offer[]):void {
  const frag=document.createDocumentFragment();
  for (const provider of ['AWS','GCP','OCI']) {
    const i=rows.findIndex(row=>row.provider===provider);
    if(i<0)continue;
    const x=rows[i];
    const card=document.createElement('button');
    card.type='button';card.className='leader';
    const head=add(card,'div',undefined,'leader-head');
    add(head,'span',provider,'provider '+provider.toLowerCase());
    add(head,'span','Rang '+(i+1),'leader-rank');
    const cost=add(card,'div',undefined,'leader-price');
    add(cost,'span',format(score(x)));
    add(cost,'small',' / Einheit · h');
    add(card,'div',x.instance+' · '+x.arch,'leader-vm');
    const method=x.provider==='OCI' && x.model==='Spot'?'Preemptible −50% (berechnet)':x.model;
    add(card,'div',method+' · '+x.vcpu+' vCPU / '+x.ram+' GiB','leader-note');
    add(card,'div',x.geo==='global'?'Globaler OCI-Listenpreis · Verfügbarkeit ungeprüft':x.region,'leader-region');
    card.setAttribute('aria-label',provider+' Rang '+(i+1)+' im Ranking anzeigen');
    card.addEventListener('click',()=>{
      if(state.limit<i+1){state.limit=Math.ceil((i+1)/100)*100;render();}
      document.getElementById('offer-'+i)?.scrollIntoView({behavior:'smooth',block:'center'});
    });
    frag.append(card);
  }
  $('provider-leaders').replaceChildren(frag);
}
function render():void {
  $('toggle-eu').setAttribute('aria-pressed',String(state.eu));
  $('toggle-us').setAttribute('aria-pressed',String(state.us));
  $<HTMLSelectElement>('max-vcpu').value=String(state.maxVcpu);
  $('scope-text').textContent=state.eu&&state.us?'Europa + USA':state.eu?'Nur Europa':'Nur USA';
  state.sorted=ranking(offers,state);
  const rows=state.sorted;
  $('best').textContent=rows.length?format(score(rows[0])):'–';
  $('best-name').textContent=rows.length?rows[0].provider+' · '+rows[0].instance+' · '+(rows[0].geo==='global'?'global':rows[0].region):'Kein Angebot';
  $('count').textContent=nice(rows.length);
  $('count-foot').textContent=[...new Set(rows.map(x=>x.provider))].join(' · ');
  $('spot-count').textContent=nice(rows.filter(x=>x.model==='Spot').length);
  $('rank-count').textContent='· '+nice(rows.length)+' Einträge';
  renderLeaders(rows);
  const frag=document.createDocumentFragment();
  rows.slice(0,state.limit).forEach((x,i)=>frag.appendChild(createRow(x,i,score(rows[0]))));
  $('results').replaceChildren(frag);
  $<HTMLButtonElement>('more').hidden=rows.length<=state.limit;
  $('more').textContent='Weitere '+nice(Math.min(100,rows.length-state.limit))+' Angebote anzeigen';
}
for (const geo of ['eu','us'] as const) {
  $('toggle-'+geo).addEventListener('click',()=>{
    if(state[geo]&&!state[geo==='eu'?'us':'eu'])return;
    state[geo]=!state[geo];state.limit=100;render();
  });
}
$<HTMLSelectElement>('max-vcpu').addEventListener('change',event=>{
  state.maxVcpu=Number((event.target as HTMLSelectElement).value);state.limit=100;render();
});
$('more').addEventListener('click',()=>{state.limit+=100;render();});
$('export').addEventListener('click',()=>{
  const escapeCell=(v:unknown)=>'"'+String(v??'').replaceAll('"','""')+'"';
  const lines=[columns.join(','),...state.sorted.map(x=>columns.map(k=>escapeCell(k==='per_unit_hour_usd'?score(x):x[k as keyof Offer])).join(','))];
  const url=URL.createObjectURL(new Blob([lines.join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;
  a.download='cloud-ci-ranking-'+(state.eu?'eu':'')+(state.us?'us':'')+'-max'+state.maxVcpu+'vcpu.csv';
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
function decodeSnapshot(data:{fetched:string,quotes:Array<[string,string,string,string,string,number,number,string,number,string,string,string]>}):Offer[]{
 return data.quotes.map(([provider,instance,family,arch,processor,vcpu,ram,model,hour_usd,region,geo,interruption])=>({
  provider:provider as Offer['provider'],instance,family,arch,processor,vcpu,ram,model:model as Offer['model'],
  hour_usd,region,geo:geo as Offer['geo'],source:'https://instances.vantage.sh/',evidence:'Offline API-Snapshot',asof:data.fetched.slice(0,10),data_class:'snapshot',interruption:interruption||null
 }));
}
async function main(){
  try {
    const response=await fetch('/api/prices',{cache:'no-store'});
    if(!response.ok)throw new Error('API HTTP '+response.status);
    const data=await response.json() as DataEnvelope;
    if(data.offers.length) {
      offers=data.offers;
      $('data-warning').textContent='D1 Live-Daten, letzter Preisimport: '+(data.updatedAt||'unbekannt')+(Object.values(data.providers).some(p=>p?.error)?' · Einige Quellen haben Importfehler':'');
    } else {
      throw new Error('Noch keine D1-Preisdaten importiert');
    }
  } catch(err) {
    try {
      const response=await fetch('/snapshot.json');
      if(!response.ok)throw new Error('HTTP '+response.status);
      const snapshot=await response.json();
      offers=decodeSnapshot(snapshot);
      $('data-warning').textContent='Offline-Fallback-Snapshot '+snapshot.fetched+' · '+String(err)+' · Für aktuelle Preise den Cron-Import initialisieren.';
    } catch(error) {
      $('data-warning').textContent='Preisdaten nicht verfügbar: '+String(error);
    }
  }
  render();
}
void main();
