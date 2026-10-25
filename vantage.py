"""Vantage instances.vantage.sh public JSON pricing feed adapter.

No API key required for bulk datasets; authenticated /api/v1/instances endpoints
are useful for point lookups but not necessary for complete rankings.
"""
from __future__ import annotations
import codecs
import datetime as dt
import json
import math
import urllib.request
from typing import Iterator

URLS = {
    'AWS': 'https://instances.vantage.sh/instances.json',
    'GCP': 'https://instances.vantage.sh/gcp/instances.json',
}
USER_AGENT = 'cloud-ci-rank/0.2 (read-only pricing comparison)'


def stream_json_array(response, chunk_size=1024 * 1024) -> Iterator[dict]:
    """Parse very large top-level JSON arrays with bounded memory, stdlib only.

    Vantage EC2 feed is ~320 MB. Reads one item at a time, not the entire feed.
    """
    decoder = json.JSONDecoder()
    utf8 = codecs.getincrementaldecoder('utf-8')()
    buf, pos, eof, begun = '', 0, False, False
    while True:
        while pos < len(buf) and buf[pos].isspace():
            pos += 1
        if not begun and pos < len(buf):
            if buf[pos] != '[':
                raise ValueError('Expected JSON array')
            begun = True
            pos += 1
            continue
        if begun and pos < len(buf) and buf[pos] in ',]':
            if buf[pos] == ']':
                return
            pos += 1
            continue
        if begun and pos < len(buf):
            try:
                item, end = decoder.raw_decode(buf, pos)
            except json.JSONDecodeError:
                if eof:
                    raise ValueError('Invalid or truncated Vantage JSON feed') from None
            else:
                if not isinstance(item, dict):
                    raise ValueError('Expected JSON objects')
                yield item
                pos = end
                continue
        if eof:
            raise ValueError('Truncated Vantage JSON feed')
        # Trim consumed prefix so memory is bounded to approximately one item + a chunk.
        if pos:
            buf = buf[pos:]
            pos = 0
        part = response.read(chunk_size)
        if part:
            buf += utf8.decode(part)
        else:
            buf += utf8.decode(b'', final=True)
            eof = True


def get_instances(provider: str) -> Iterator[dict]:
    url = URLS[provider]
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=90) as response:
        yield from stream_json_array(response)


def amount(value):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) and n > 0 else None


def region_group(provider: str, region: str) -> str | None:
    """Regions intentionally limited to geographic Europe and continental US.

    OCI global list prices are handled separately (not evidence of availability).
    """
    if region.startswith(('cn-', 'us-gov-', 'us-iso-', 'us-isob-', 'eu-isoe-')):
        return None
    if provider == 'AWS':
        if region.startswith('eu-') and not region.startswith('eu-isoe-'):
            return 'eu'
        if region.startswith('us-') and not region.startswith(('us-gov-', 'us-iso-', 'us-isob-')):
            return 'us'
    elif provider == 'GCP':
        if region.startswith('europe-'):
            return 'eu'
        if region.startswith('us-'):
            return 'us'
    return None


def allowed_region(region: str) -> bool:
    """Legacy helper: checks inclusion in the Europe/USA comparison."""
    return bool(region_group('AWS', region) or region_group('GCP', region))


def aws_arch(x):
    arch = x.get('arch') or []
    if isinstance(arch, str):
        arch = [arch]
    if 'arm64' in arch:
        return 'ARM64'
    if 'x86_64' in arch or 'x86-64' in arch:
        return 'x86-64'
    return 'unknown'


def gcp_arch(name):
    # Vantage GCP feed omits CPU architecture; only known Arm families are labeled.
    if name.startswith(('c4a-', 't2a-', 'n4a-')):
        return 'ARM64'
    if name.startswith(('c4d-', 'c3d-', 'c3-', 'c4-', 'c2-', 'e2-', 'n1-', 'n2-', 'n2d-', 'n4-', 't2d-')):
        return 'x86-64'
    return 'unknown'


def per_unit_score(row):
    return row['hour_usd'] / min(row['vcpu'], row['ram'] / 2)


def quote_rows(provider: str, x: dict, stamp=None):
    name = x.get('instance_type') or ''
    vcpu = int(x.get('vCPU') or 0)
    ram = float(x.get('memory') or 0)
    if not (8 <= vcpu <= 64) or ram < 16 or x.get('GPU', 0) or x.get('FPGA', 0):
        return []
    if provider == 'AWS' and name.startswith(('t2.', 't3.', 't3a.', 't4g.', 'inf', 'trn', 'dl', 'p2.', 'p3.', 'p4', 'p5', 'g3.', 'g4', 'g5', 'f1.', 'vt', 'mac', 'hpc')):
        return []
    if provider == 'GCP' and x.get('shared_cpu'):
        return []
    if name.endswith(('.metal', '-metal')):
        return []
    arch = aws_arch(x) if provider == 'AWS' else gcp_arch(name)
    family = name.split('.')[0] if provider == 'AWS' else name.rsplit('-', 1)[0]
    processor = x.get('physical_processor') or ('Google Axion' if arch == 'ARM64' else 'CPU generation not specified')
    stamp = stamp or dt.date.today().isoformat()
    out = []
    for region, platform in (x.get('pricing') or {}).items():
        group = region_group(provider, region)
        if group is None or not isinstance(platform, dict):
            continue
        linux = platform.get('linux') or {}
        if not isinstance(linux, dict):
            continue
        for model, key in [('Spot', 'spot_avg' if provider == 'AWS' else 'spot'), ('On-Demand', 'ondemand')]:
            price = amount(linux.get(key))
            if price is None:
                continue
            detail = (f'Vantage 7-day Spot average (min {linux.get("spot_min", "-")}, max {linux.get("spot_max", "-")}, interruption {linux.get("pct_interrupt", "-")})'
                      if provider == 'AWS' and model == 'Spot' else 'Vantage regional published Linux pricing')
            out.append(dict(provider=provider, instance=name, family=family, arch=arch, processor=processor,
                            vcpu=vcpu, ram=ram, model=model, hour_usd=price, region=region, source=URLS[provider],
                            evidence=detail, asof=stamp, data_class='live-vantage', geo=group,
                            interruption=(linux.get('pct_interrupt') if provider == 'AWS' and model == 'Spot' else None)))
    return out


def best_by_geo(rows: list[dict]) -> list[dict]:
    """Keep cheapest combination per geography AND per VM size.

    Keep each vCPU/RAM configuration distinct so the UI can apply a maximum
    vCPU filter before selecting the cheapest qualifying family member.
    """
    chosen = {}
    for row in rows:
        geo = row.get('geo', 'global')
        key = (row['provider'], row.get('family', row['instance']),
               row['model'], row['arch'], geo, row['vcpu'], row['ram'])
        if key not in chosen or (per_unit_score(row), row['hour_usd']) < (per_unit_score(chosen[key]), chosen[key]['hour_usd']):
            chosen[key] = row
    return list(chosen.values())


def fetch_vantage(provider: str):
    """Stream feeds, retaining each size per family/model and geography."""
    if provider not in URLS:
        raise ValueError('Unsupported Vantage provider')
    chosen = {}
    parsed = 0
    for instance in get_instances(provider):
        parsed += 1
        for row in quote_rows(provider, instance):
            key = (row['family'], row['model'], row['arch'], row['geo'], row['vcpu'], row['ram'])
            if key not in chosen or (per_unit_score(row), row['hour_usd']) < (per_unit_score(chosen[key]), chosen[key]['hour_usd']):
                chosen[key] = row
    if not chosen:
        raise RuntimeError('Vantage returned no usable instance prices')
    return list(chosen.values()), parsed
