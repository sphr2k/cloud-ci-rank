export type Provider = 'AWS' | 'GCP' | 'OCI';
export type Geography = 'eu' | 'us' | 'global';
export type PurchaseModel = 'Spot' | 'On-Demand';

export interface Offer {
  provider: Provider; instance: string; family: string; arch: string;
  processor: string; vcpu: number; ram: number; model: PurchaseModel;
  hour_usd: number; region: string; geo: Geography; source: string;
  evidence: string; asof: string; data_class: string; interruption: string | null;
}
export interface DataEnvelope {
  updatedAt: string;
  providers: Partial<Record<Provider, { checkedAt: string; changedAt: string; records: number; error?: string }>>;
  offers: Offer[];
}
export const score = (x: Offer) => x.hour_usd / Math.min(x.vcpu, x.ram / 2);
export function bestByGeo(rows: Iterable<Offer>): Offer[] {
  const best = new Map<string, Offer>();
  for (const x of rows) {
    const k = [x.provider, x.family || x.instance, x.model, x.arch, x.geo, x.vcpu, x.ram].join('|');
    const prior = best.get(k);
    if (!prior || score(x) < score(prior) || (score(x) === score(prior) && x.hour_usd < prior.hour_usd)) best.set(k,x);
  }
  return [...best.values()];
}
export interface Selection { eu: boolean; us: boolean; maxVcpu: number; }
export function ranking(rows: Iterable<Offer>, s: Selection): Offer[] {
  const best = new Map<string,Offer>();
  for (const x of rows) {
    if (x.vcpu > s.maxVcpu) continue;
    if (!(x.geo === 'global' || (x.geo === 'eu' && s.eu) || (x.geo === 'us' && s.us))) continue;
    const k = [x.provider,x.family || x.instance,x.model,x.arch].join('|');
    const prior = best.get(k);
    if (!prior || score(x) < score(prior) || (score(x) === score(prior) && x.hour_usd < prior.hour_usd)) best.set(k,x);
  }
  return [...best.values()].sort((a,b) => score(a)-score(b) || a.hour_usd-b.hour_usd || a.instance.localeCompare(b.instance));
}
