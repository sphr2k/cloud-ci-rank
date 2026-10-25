#!/usr/bin/env python3
"""Cloud CI cost leaderboard. Python stdlib only. See README for source limitations."""
from __future__ import annotations
import argparse, csv, datetime as dt, html, json, math, pathlib, urllib.request, urllib.parse
from vantage import fetch_vantage

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / 'data' / 'seed.json'
SNAPSHOT = HERE / 'data' / 'region_snapshot.json'
OUT = HERE / 'index.html'
AWS_API = 'https://go.runs-on.com/api/finder'
OCI_API = 'https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/'
OCI_PARTS = {
    'A4': ('B112145', 'B112146'),
    'A2': ('B109529', 'B109530'),
    'E4': ('B93113', 'B93114'),
    'E5': ('B97384', 'B97385'),
    'E6': ('B111129', 'B111130'),
}

def get_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'cloud-ci-rank/0.1 (personal pricing comparison)', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)



def load_snapshot():
    """Read compact, genuine EU+US pricing snapshot (top 35 per geo/provider/model)."""
    if not SNAPSHOT.exists():
        return json.loads(DATA.read_text(encoding='utf-8')), 'Fallback: hand-curated seed prices'
    data = json.loads(SNAPSHOT.read_text(encoding='utf-8'))
    source_map = {
        'AWS': 'https://instances.vantage.sh/instances.json',
        'GCP': 'https://instances.vantage.sh/gcp/instances.json',
        'OCI': OCI_API,
    }
    rows = []
    for packed in data['quotes']:
        provider,instance,family,arch,processor,vcpu,ram,model,hour_usd,region,geo,interruption = packed
        rows.append(dict(provider=provider,instance=instance,family=family,arch=arch,processor=processor,
                         vcpu=vcpu,ram=ram,model=model,hour_usd=hour_usd,region=region,geo=geo,
                         source=source_map[provider],evidence=('Oracle PAYG + modeled 50% preemptible' if provider=='OCI' else 'Vantage regional pricing'),
                         asof=data['fetched'][:10],data_class='snapshot',interruption=interruption or None))
    return rows, f"API-Snapshot vom {data['fetched'][:10]}: jeweils die 35 günstigsten Instanzfamilien pro Cloud/Region/Tarif (nicht der volle API-Katalog)."
def rank_score(p):
    # Capacity for equivalent bundles of 1 advertised vCPU + 2 GiB RAM.
    # Extra memory and excess CPU are not assumed useful to this workload.
    units = min(p['vcpu'], p['ram'] / 2.0)
    return p['hour_usd'] / units if units else float('inf')

def fetch_aws():
    rows, total = fetch_vantage('AWS')
    print(f'  Vantage AWS: {total} instance types parsed')
    return rows


def fetch_gcp():
    rows, total = fetch_vantage('GCP')
    print(f'  Vantage GCP: {total} instance types parsed')
    return rows

def oracle_price(pn):
    url = OCI_API + '?' + urllib.parse.urlencode({'partNumber':pn,'currencyCode':'USD'})
    data = get_json(url)
    for item in data.get('items', []):
        if item.get('partNumber') != pn: continue
        for money in item.get('currencyCodeLocalizations', item.get('prices', [])):
            if money.get('currencyCode') != 'USD': continue
            for price in money.get('prices', []):
                if price.get('model') == 'PAY_AS_YOU_GO' and price.get('value') is not None:
                    return float(price['value'])
    raise ValueError(f'No USD PAY_AS_YOU_GO price for {pn}')

def fetch_oci():
    # Shape availability is NOT returned by Oracle's price-list API.
    # Spot is explicitly supported for A4, E4, E5, E6 (50% preemptible discount).
    out=[]
    for family,(cpu_part,ram_part) in OCI_PARTS.items():
        cpu_price, ram_price = oracle_price(cpu_part), oracle_price(ram_part)
        for ram in ([32,64] if family=='A4' else [32]):
            on = 8*cpu_price + ram*ram_price # 16 vCPU = 8 OCPU for A2/A4/x86
            for model in (['Spot','On-Demand'] if family in ('A4','E4','E5','E6') else ['On-Demand']):
                out.append(dict(provider='OCI',instance=f'VM.Standard.{family}.Flex',arch='ARM64' if family[0]=='A' else 'x86-64',
                                processor={'A4':'AmpereOne M','A2':'AmpereOne'}.get(family,'AMD EPYC'),vcpu=16,ram=ram,
                                model=model,hour_usd=on*(0.5 if model=='Spot' else 1),region='global list price',geo='global',
                                source=OCI_API, evidence=f'Oracle PAYG SKUs {cpu_part}/{ram_part}; '+('Spot 50% rule' if model=='Spot' else 'On-Demand'),
                                asof=dt.date.today().isoformat(),family=family))
    return out

def esc(v): return html.escape(str(v), quote=True)

def fmt_price(x): return f'${x:.5f}' if x < .1 else f'${x:.4f}'

def write_html(items, notes=None, offline=False):
    """Embed region-specific prices; calculate the winning region in the browser.

    `items` retains the best regional offer separately for every VM size;
    never collapse the geographies together before client selection.
    """
    from vantage import best_by_geo
    now = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    records = best_by_geo(items)
    records.sort(key=lambda r: (rank_score(r), r['provider'], r['instance'], r.get('geo', 'global')))
    payload = json.dumps(records, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
    template = (HERE / 'ui_template.html').read_text(encoding='utf-8')
    status = 'API-Snapshot (nicht live).' if offline else 'API-Refresh durchgeführt; fehlgeschlagene Provider siehe unten.'
    if notes:
        status += ' ' + ' '.join(notes)
    page = (template.replace('__TIMESTAMP__', esc(now))
                    .replace('__DATA_JSON__', payload)
                    .replace('__STATUS__', esc(status)))
    OUT.write_text(page, encoding='utf-8')
    # Default CSV matches the UI with Europe+USA and max 16 vCPU.
    best = {}
    for row in records:
        if row["vcpu"] > 16:
            continue
        key = (row['provider'], row.get('family', row['instance']), row['model'], row['arch'])
        if key not in best or (rank_score(row),row['hour_usd']) < (rank_score(best[key]),best[key]['hour_usd']):
            best[key] = row
    ranked = sorted(best.values(), key=lambda p:(rank_score(p),p['hour_usd'],p['provider']))
    with (HERE/'ranking.csv').open('w', newline='', encoding='utf-8') as f:
        cols=['provider','instance','arch','processor','model','geo','region','vcpu','ram','hour_usd','per_unit_hour_usd','source','evidence','asof','data_class','interruption']
        w=csv.DictWriter(f,fieldnames=cols);w.writeheader()
        for p in ranked:
            w.writerow({k: (round(rank_score(p),8) if k=='per_unit_hour_usd' else p.get(k,'')) for k in cols})
    return ranked

def main():
    parser=argparse.ArgumentParser(description='Cloud CI cost ranking with Europe/USA selectors.')
    parser.add_argument('--offline', action='store_true', help='Use dated seed data without network access (for demos/tests).')
    parser.add_argument('--refresh',action='store_true',help='Compatibility alias: refresh is now the default.')
    p=parser.parse_args()
    records,snapshot_note=load_snapshot()
    for row in records:
        if not row.get('geo'):
            from vantage import region_group
            row['geo'] = 'global' if row['provider']=='OCI' else (region_group(row['provider'],row.get('region','')) or 'excluded')
    records=[row for row in records if row['geo']!='excluded']
    notes=[]
    if not p.offline:
        for provider,fn in [('AWS',fetch_aws),('GCP',fetch_gcp),('OCI',fetch_oci)]:
            try:
                fresh=fn()
                if not fresh: raise RuntimeError('empty provider response')
                records=[x for x in records if x['provider']!=provider]+fresh
                print(f'{provider}: refreshed {len(fresh)} quotes')
            except Exception as ex:
                notes.append(f'{provider} API-Refresh fehlgeschlagen; Snapshot beibehalten: {ex}')
                print(notes[-1])
        notes.append('Vantage AWS uses 7-day Spot averages, GCP published regional Spot prices; OCI uses Oracle PAYG SKUs and a 50% Spot model. API feeds do not prove actual capacity.')
    else:
        notes.append(snapshot_note + ' Für vollständige Daten python3 rank.py ausführen.')
    ranked=write_html(records, notes, offline=p.offline)
    print(f'Wrote {OUT} and {HERE/"ranking.csv"} ({len(ranked)} rows)')
    for n,x in enumerate(ranked[:10],1): print(f'{n:2}. {x["provider"]:3} {x["instance"]:25} {x["model"]:9} ${rank_score(x):.5f}/unit·h  ${x["hour_usd"]:.4f}/h')

if __name__=='__main__': main()
