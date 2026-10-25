import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bestByGeo,ranking} from '../src/pricing';
import {quoteRows,parseVantage,streamJsonObjects,oracleSkuPrice} from '../src/feeds';
const common = {instance:'c4a-highcpu-16',family:'c4a-highcpu',provider:'GCP' as const,arch:'ARM64',processor:'Axion',model:'Spot' as const,ram:32,vcpu:16,region:'us-central1',geo:'us' as const,source:'vantage',evidence:'test',asof:'2026-10-25',data_class:'live',interruption:null};
test('ranking retains sizes, chooses cheapest geo, max vcpu=16',()=>{
 const data=[{...common,hour_usd:0.32},{...common,region:'eu-west3',geo:'eu' as const,hour_usd:.20},{...common,instance:'c4a-highcpu-32',vcpu:32,ram:64,hour_usd:.12}];
 assert.equal(bestByGeo(data).length,3);
 assert.equal(ranking(data,{us:true,eu:true,maxVcpu:16})[0].region,'eu-west3');
 assert.equal(ranking(data,{us:true,eu:false,maxVcpu:16})[0].hour_usd,.32);
 assert.equal(ranking(data,{us:true,eu:false,maxVcpu:32})[0].vcpu,32);
});
test('AWS spot_avg not spot_min and excluded regions',()=>{
 const rows=quoteRows('AWS',{instance_type:'c8g.4xlarge',vCPU:16,memory:32,arch:['arm64'],pricing:{
 'us-east-1':{linux:{ondemand:0.6,spot_avg:'0.25',spot_min:'0.12',pct_interrupt:'<5%'}},
 'ap-southeast-1':{linux:{spot_avg:0.0001}},
 'us-gov-west-1':{linux:{spot_avg:0.0001}}}},'2026-10-25');
 assert.equal(rows.length,2);
 assert.equal(rows.find(x=>x.model==='Spot')!.hour_usd,0.25);
});
test('streaming JSON parses escaped strings across arbitrary byte boundaries',async()=>{
 const json=JSON.stringify([{name:'A \\\\"hello"',x:{a:1}},{name:'second',array:[{inner:2}]}]);
 const buffer=new TextEncoder().encode(json);
 const body=new ReadableStream<Uint8Array>({start(controller){for(let i=0;i<buffer.length;i+=3)controller.enqueue(buffer.slice(i,i+3));controller.close()}});
 const results=[];
 for await (const x of streamJsonObjects(body))results.push(x);
 assert.equal(results.length,2);
 assert.deepEqual(results[1].array,[{inner:2}]);
});
test('streaming Vantage keeps cheapest region per family + size',async()=>{
 const data=[{instance_type:'c8g.4xlarge',vCPU:16,memory:32,arch:['arm64'],pricing:{'us-east-1':{linux:{spot_avg:'0.25'}},'us-west-2':{linux:{spot_avg:'0.2'}}}}];
 const body=new Response(JSON.stringify(data)).body!;
 const res=await parseVantage('AWS',body,'2026-10-25');
 assert.equal(res.offers.length,1);
 assert.equal(res.offers[0].region,'us-west-2');
});
test('OCI pricing uses USD PAYG localization',()=>{
 assert.equal(oracleSkuPrice({items:[{partNumber:'B112145',currencyCodeLocalizations:[{currencyCode:'USD',prices:[{model:'PAY_AS_YOU_GO',value:.0138}]}]}]},'B112145'),.0138);
});
