import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bestByGeo,score,throughputPerDollar,ranking,type Offer} from '../src/pricing';
import {keeperRows,fetchKeeperAll,COUNTRIES,KEEPER_VENDORS} from '../src/keeper';

const row:Offer={
 provider:'AWS',instance:'c8g.4xlarge',family:'c8g',arch:'ARM64',processor:'Graviton 4',
 vcpu:16,ram:32,model:'Spot',hour_usd:.25,region:'US',geo:'us',
 source:'test',evidence:'test',asof:'2026-10-25',data_class:'keeper',interruption:null,
 benchAll:32000,benchSingle:3200
};
test('allcore/$ primary ranking distinguishes efficiency, falls back only for unmeasured',()=>{
 const fast={...row,instance:'fast',family:'fast',hour_usd:.3,benchAll:65000};
 const cheap={...row,instance:'cheap',family:'cheap',hour_usd:.08,benchAll:8000};
 const missing={...row,instance:'missing',family:'missing',hour_usd:.01,benchAll:null};
 assert.equal(ranking([cheap,fast,missing],{eu:false,us:true,maxVcpu:16})[0].instance,'fast');
 assert.equal(ranking([cheap,fast,missing],{eu:false,us:true,maxVcpu:16})[2].instance,'missing');
 assert.equal(ranking([cheap,fast],{eu:false,us:true,maxVcpu:16,metric:'nominal'})[0].instance,'cheap');
});
test('2 GiB/vCPU memory correction penalizes underprovisioned machines',()=>{
 assert.equal(throughputPerDollar({...row,ram:16}),throughputPerDollar(row)!/2);
});
test('cheapest country per family,size,tier retained for EU and US',()=>{
 const a={...row,geo:'eu' as const,region:'Deutschland',hour_usd:0.18};
 const b={...row,geo:'eu' as const,region:'Frankreich',hour_usd:0.16};
 assert.equal(bestByGeo([row,a,b]).length,2);
 assert.equal(ranking([a,b,row],{eu:true,us:false,maxVcpu:16})[0].region,'Frankreich');
});
test('normalizes Keeper price options and benchmark, excludes non-US/non-EU and GPU',()=>{
 const fixture=[{vendor_id:'gcp',server_id:'abc',name:'c4a-highcpu-16',family:'c4a',vcpus:16,memory_amount:32768,
  cpu_architecture:'arm64',accelerator_count:0,selected_benchmark_score:45000,
  min_price_spot:0.14,min_price_ondemand:.44,status:'active'}];
 const rows=keeperRows(fixture,'DE',new Map([['gcp:abc',4000]]));
 assert.equal(rows.length,2);
 assert.equal(rows[0].provider,'GCP');
 assert.equal(rows[0].geo,'eu');
 assert.equal(rows[0].benchAll,45000);
 assert.equal(rows[0].benchSingle,4000);
});
test('primary sources cover eight providers and only one country per request',()=>{
 assert.equal(KEEPER_VENDORS.length,8);
 assert.equal(COUNTRIES.filter(x=>x==='US').length,1);
});

test('AWS exact region filter does not accidentally use another region in same country',()=>{
 const sweden={...row,geo:'eu' as const,region:'Stockholm (eu-north-1)',regionId:'eu-north-1',countryCode:'SE',hour_usd:.0393};
 const london={...row,geo:'eu' as const,region:'London (eu-west-2)',regionId:'eu-west-2',countryCode:'GB',hour_usd:.0455};
 const countryMinimum={...row,geo:'eu' as const,region:'Schweden (SE)',regionId:null,countryCode:'SE',hour_usd:.02};
 assert.equal(ranking([sweden,london,countryMinimum],{eu:true,us:true,maxVcpu:16,regionFilter:'aws:eu-north-1'}).length,1);
 assert.equal(ranking([sweden,london,countryMinimum],{eu:true,us:true,maxVcpu:16,regionFilter:'aws:eu-north-1'})[0].hour_usd,.0393);
 assert.equal(ranking([sweden,london,countryMinimum],{eu:true,us:true,maxVcpu:16,regionFilter:'country:GB'})[0].regionId,'eu-west-2');
});
test('Buildkite official v1.4.0 AMI preset excludes Spain and non-AWS providers',()=>{
 const eligible={...row,geo:'eu' as const,regionId:'eu-north-1',countryCode:'SE',hour_usd:.05};
 const excluded={...row,geo:'eu' as const,instance:'spanish',regionId:'eu-south-2',countryCode:'ES',hour_usd:.01};
 const other={...eligible,provider:'GCP' as const,instance:'gcp',hour_usd:.005};
 const chosen=ranking([eligible,excluded,other],{eu:true,us:false,maxVcpu:16,regionFilter:'buildkite'});
 assert.equal(chosen.length,1);
 assert.equal(chosen[0].regionId,'eu-north-1');
});
test('country and region candidate compaction preserves per-region alternatives',()=>{
 const a={...row,regionId:'eu-north-1',countryCode:'SE',geo:'eu' as const,region:'Stockholm',hour_usd:.0393};
 const b={...row,regionId:'eu-west-2',countryCode:'GB',geo:'eu' as const,region:'London',hour_usd:.0455};
 assert.equal(bestByGeo([a,b]).length,2);
});
test('AWS Keeper conversion marks region-scoped quotes with region and country keys',()=>{
 const fixture=[{vendor_id:'aws',server_id:'c7gd.2xlarge',name:'c7gd.2xlarge',family:'c7gd',vcpus:8,memory_amount:16384,
  cpu_architecture:'arm64',accelerator_count:0,selected_benchmark_score:12242.3,min_price_spot:.0393,
  min_price_ondemand:.3931,status:'active'}];
 const reg={regionId:'eu-north-1',country:'SE',name:'Stockholm'};
 const rows=keeperRows(fixture,'SE',new Map([['aws:c7gd.2xlarge',1532]]),reg);
 assert.equal(rows.length,2);
 assert.equal(rows[0].regionId,'eu-north-1');
 assert.equal(rows[0].countryCode,'SE');
 assert.equal(rows[0].hour_usd,.0393);
 assert.match(rows[0].evidence,/region-minimum/);
});

test('architecture selector combines with AWS region and Buildkite presets',()=>{
 const a={...row,regionId:'eu-central-1',countryCode:'DE',geo:'eu' as const,arch:'ARM64'};
 const x={...a,instance:'amd',family:'amd',arch:'x86-64'};
 assert.deepEqual(ranking([a,x],{eu:true,us:false,maxVcpu:16,arch:'ARM64',regionFilter:'buildkite'}).map(v=>v.arch),['ARM64']);
 assert.deepEqual(ranking([a,x],{eu:true,us:false,maxVcpu:16,arch:'x86-64',regionFilter:'aws:eu-central-1'}).map(v=>v.arch),['x86-64']);
 assert.equal(ranking([a,x],{eu:true,us:false,maxVcpu:16,arch:'ARM64',regionFilter:'aws:us-east-1'}).length,0);
});
