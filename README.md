# Cloud CI Cost Leaderboard (quick prototype)

A **single price ranking**, not a general-purpose cloud comparison tool. Two geographic switches: **Europe** and **USA** (both initially selected), plus **Max. vCPU** (defaults to 16; selectable 8–64). No Asia. The selected regions are used to choose the cheapest regional offer for every instance family and purchase model; the ordering and prices change immediately in the HTML UI.

## Open

Open `index.html` in a browser. No server required. The page embeds a real **2026-10-25 API snapshot**, not the older manual seed. The offline preview is deliberately limited to the **35 cheapest families per provider + geographical region + tariff**, selected before applying the vCPU filter; therefore it is not exhaustive. A full API refresh is required for complete filtered rankings. OCI comes from the official Oracle SKU list and is displayed as **global, unverified availability**.

Run with Python 3 standard library (no pip dependencies):

```sh
python3 rank.py           # refresh from the full Vantage AWS/GCP feeds + OCI SKU API
python3 rank.py --offline # rebuild using the included API snapshot (no network)
python3 -m unittest discover -s tests -v
```

`rank.py` regenerates `index.html` and a `ranking.csv` matching the default *Europe + USA, max. 16 vCPU* view. The maximum-vCPU selector applies to the VM size, not the sum of cores across CI jobs. Clicking **CSV exportieren** downloads the current selection instead. `ui_template.html` contains the HTML, CSS, and JavaScript. The HTML itself includes all pricing data so that regional switching works offline.

### Sources

- AWS Vantage: https://instances.vantage.sh/instances.json (~320 MB feed), `linux.spot_avg` (seven-day average), `linux.ondemand`, cores, RAM, processor, architecture, region and `pct_interrupt` where available.
- GCP Vantage: https://instances.vantage.sh/gcp/instances.json (~6 MB), `linux.spot` and `linux.ondemand`, cores, RAM, region. Architecture is inferred from recognized instance families because Vantage does not explicitly include this property for GCP.
- OCI public SKU API: https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/, A2/A4/E4/E5/E6. Spot is modeled at 50% of compute + memory PAYG where included; **this is not a verified Spot quote or availability check**. OCI A1 intentionally excluded.

The dedicated bearer-token Vantage Instances API was tested independently, but the public bulk feeds do not require a token. **No API key is embedded or saved.** The script streams the large AWS feed with bounded memory.

### Regional behavior

- AWS Europe: regular `eu-...` regions (not isolated regions); USA: commercial `us-...` regions (excluding GovCloud and isolated regions).
- GCP Europe: `europe-...`; USA: `us-...`.
- OCI: **global list prices**, shown for either selection without falsely claiming regional availability. Oracle pricing API does not provide the regional shape inventory.
- Data acquisition retains the lowest-price offer per `(provider, family, purchase model, architecture, geography, vCPU, RAM)`. In the browser, the maximum-vCPU criterion is applied **before** selecting the cheapest eligible size per family/model and the cheapest eligible region. This prevents large VM variants from hiding smaller eligible variants.
- Only general-purpose or compute-optimized Linux CPU instances with 8–64 vCPUs and at least 16 GiB RAM are considered. GPUs, AWS burstable families, AWS metal, GCP shared-vCPU and restricted regions are excluded.

### Ranking metric

```text
capacity_units = min(advertised_vCPU, RAM_GiB / 2)
USD_per_unit_hour = VM_hourly_price / capacity_units
```

This is a **capacity-price** ranking, **not CPU benchmark normalization**. AMD/Intel SMT vCPU and ARM cores are not treated as equivalent performance. Storage (EBS, Hyperdisk, OCI volumes), quotas, Spot interruption, availability, network/egress, cold boot, and per-job execution performance are not part of the score.

No live spot capacity verification is performed, and some regional list/Spot prices may not be actionable. The browser shows data snapshot date and any provider-refresh failures.
