import { bestByGeo, score, type Offer, type Provider, type Geography } from './pricing';

export const VANTAGE = {
  AWS: 'https://instances.vantage.sh/instances.json',
  GCP: 'https://instances.vantage.sh/gcp/instances.json',
};
export const OCI_API = 'https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/';
export const OCI_PARTS: Record<string, readonly [string,string]> = {
  A4: ['B112145','B112146'], A2: ['B109529','B109530'],
  E4: ['B93113','B93114'], E5: ['B97384','B97385'], E6: ['B111129','B111130'],
};

export function regionGroup(provider: Provider, region: string): Geography | null {
  if (/^(cn-|us-gov-|us-iso-|us-isob-|eu-isoe-)/.test(region)) return null;
  if (provider === 'AWS') return region.startsWith('eu-') ? 'eu' : region.startsWith('us-') ? 'us' : null;
  if (provider === 'GCP') return region.startsWith('europe-') ? 'eu' : region.startsWith('us-') ? 'us' : null;
  return 'global';
}
const validPrice = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
export function quoteRows(provider: 'AWS'|'GCP', x: Record<string, any>, date: string): Offer[] {
  const name = String(x.instance_type || '');
  const vcpu = Number(x.vCPU || 0), ram = Number(x.memory || 0);
  if (!Number.isInteger(vcpu) || vcpu < 8 || vcpu > 64 || ram < 16 || x.GPU || x.FPGA) return [];
  if (provider === 'AWS' && /^(t2\.|t3\.|t3a\.|t4g\.|inf|trn|dl|p2\.|p3\.|p4|p5|g3\.|g4|g5|f1\.|vt|mac|hpc)/.test(name)) return [];
  if (provider === 'GCP' && x.shared_cpu) return [];
  if (name.endsWith('.metal') || name.endsWith('-metal')) return [];
  const arch = provider === 'AWS' ?
    (Array.isArray(x.arch) && x.arch.includes('arm64') ? 'ARM64' : Array.isArray(x.arch) && x.arch.includes('x86_64') ? 'x86-64' : 'unknown')
    : /^(c4a-|t2a-|n4a-)/.test(name) ? 'ARM64'
    : /^(c4d-|c3d-|c3-|c4-|c2-|e2-|n1-|n2-|n2d-|n4-|t2d-)/.test(name) ? 'x86-64' : 'unknown';
  const family = provider === 'AWS' ? name.split('.')[0] : name.slice(0,name.lastIndexOf('-')) || name;
  const processor = String(x.physical_processor || (provider === 'GCP' && arch === 'ARM64' ? 'Google Axion' : 'CPU generation not specified'));
  const result: Offer[] = [];
  for (const [region,priceMap] of Object.entries(x.pricing || {})) {
    const geo = regionGroup(provider,region);
    if (!geo || !priceMap || typeof priceMap !== 'object') continue;
    const linux = (priceMap as Record<string,any>).linux || {};
    for (const model of ['Spot','On-Demand'] as const) {
      const v = validPrice(linux[model === 'On-Demand' ? 'ondemand' : provider === 'AWS' ? 'spot_avg' : 'spot']);
      if (v === null) continue;
      result.push({ provider,instance:name,family,arch,processor,vcpu,ram,model,hour_usd:v,region,geo,
        source:VANTAGE[provider],asof:date,data_class:'live-vantage',
        evidence:provider === 'AWS' && model === 'Spot' ? 'Vantage 7-day average' : 'Vantage published Linux pricing',
        interruption:provider === 'AWS' && model === 'Spot' ? String(linux.pct_interrupt || '') || null : null });
    }
  }
  return result;
}

/** Incremental JSON-array object decoder. Individual Vantage records are much
 * smaller than its 319MB AWS response. Preserves state across byte chunks. */
export async function* streamJsonObjects(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string,any>> {
  const reader = body.getReader();
  let depth = 0, insideString = false, slash = false, opened = false, closed = false;
  let buffered: Uint8Array[] = [], bufferedSize = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      const chunk = read.value;
      let start = depth > 0 ? 0 : -1;
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (depth === 0) {
          if (!opened && c === 91) { opened = true; continue; }
          if (opened && c === 93) { closed = true; break; }
          if (opened && c === 123) { depth = 1; insideString = false; slash = false; start = i; continue; }
          if (![9,10,13,32,44].includes(c)) throw new Error('Invalid top-level JSON array');
          continue;
        }
        if (insideString) {
          if (slash) slash = false;
          else if (c === 92) slash = true;
          else if (c === 34) insideString = false;
          continue;
        }
        if (c === 34) insideString = true;
        else if (c === 123) depth++;
        else if (c === 125 && --depth === 0) {
          const segment = chunk.subarray(start, i+1);
          const bytes = new Uint8Array(bufferedSize+segment.byteLength);
          let pos = 0;
          for (const part of buffered) { bytes.set(part,pos); pos += part.byteLength; }
          bytes.set(segment,pos);
          const parsed: unknown = JSON.parse(decoder.decode(bytes));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected JSON object');
          yield parsed as Record<string,any>;
          buffered = []; bufferedSize = 0; start = -1;
        }
      }
      if (closed) break;
      if (depth > 0 && start >= 0) {
        const partial = chunk.slice(start);
        buffered.push(partial); bufferedSize += partial.byteLength;
        if (bufferedSize > 8*1024*1024) throw new Error('Individual record exceeds 8 MB');
      }
    }
  } finally { reader.releaseLock(); }
  if (!opened || !closed) throw new Error('Truncated JSON array');
}

export async function parseVantage(provider: 'AWS'|'GCP', body: ReadableStream<Uint8Array>, date: string): Promise<{offers: Offer[],scanned:number}> {
  const best = new Map<string,Offer>();
  let scanned = 0;
  for await (const row of streamJsonObjects(body)) {
    scanned++;
    for (const x of quoteRows(provider,row,date)) {
      const key = [x.family,x.model,x.arch,x.geo,x.vcpu,x.ram].join('|');
      const prior = best.get(key);
      if (!prior || score(x) < score(prior) || (score(x) === score(prior) && x.hour_usd < prior.hour_usd)) best.set(key,x);
    }
  }
  if (!best.size) throw new Error(provider+' feed contains no eligible prices');
  return {offers:[...best.values()],scanned};
}
export function oracleSkuPrice(data: any, sku: string): number {
  const item = (data.items || []).find((x: any) => x.partNumber === sku);
  for (const currency of item?.currencyCodeLocalizations || []) {
    if (currency.currencyCode !== 'USD') continue;
    for (const price of currency.prices || []) {
      if (price.model === 'PAY_AS_YOU_GO') {
        const n = validPrice(price.value);
        if (n !== null) return n;
      }
    }
  }
  throw new Error('Missing Oracle PAYG USD price for '+sku);
}
export async function parseOracle(fetcher: typeof fetch, date: string): Promise<Offer[]> {
  const result: Offer[] = [];
  const failures: string[] = [];
  for (const [family,parts] of Object.entries(OCI_PARTS)) {
    try {
      const prices = await Promise.all(parts.map(async sku => {
        const url = OCI_API+'?'+new URLSearchParams({partNumber:sku,currencyCode:'USD'});
        const res = await fetcher(url);
        if (!res.ok) throw new Error('OCI HTTP '+res.status);
        return oracleSkuPrice(await res.json(),sku);
      }));
      const [cpuPrice,ramPrice] = prices;
      const arch = family.startsWith('A') ? 'ARM64' : 'x86-64';
      const processor = family === 'A4' ? 'AmpereOne M' : family === 'A2' ? 'AmpereOne' : 'AMD EPYC';
      for (const vcpu of [8,16,32,64]) for (const memoryRatio of [2,4]) {
        const ram = vcpu*memoryRatio;
        const onDemand = vcpu/2*cpuPrice + ram*ramPrice;
        for (const model of (family === 'A2' ? ['On-Demand'] : ['Spot','On-Demand']) as ('Spot'|'On-Demand')[]) {
          result.push({ provider:'OCI',instance:'VM.Standard.'+family+'.Flex',family,arch,processor,vcpu,ram,model,
            hour_usd:onDemand*(model === 'Spot' ? 0.5 : 1),region:'global list price',geo:'global',
            source:OCI_API, evidence:'Oracle PAYG SKUs '+parts.join('/')+(model === 'Spot'?' modeled 50% preemptible discount':''),
            asof:date,data_class:'modeled-oci',interruption:null });
        }
      }
    } catch (e) { failures.push(family+': '+String(e)); }
  }
  if (failures.length) throw new Error('Oracle missing SKU families: '+failures.join('; '));
  return bestByGeo(result);
}
