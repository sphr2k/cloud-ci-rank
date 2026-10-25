import json, pathlib, sys, unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from rank import rank_score, write_html, OCI_PARTS, oracle_price, load_snapshot
ROOT = pathlib.Path(__file__).resolve().parents[1]

class RankingTests(unittest.TestCase):
    def test_oci_current_schema(self):
        # OCI public price API uses currencyCodeLocalizations (not old prices envelope).
        from unittest.mock import patch
        data={"items":[{"partNumber":"B112145","currencyCodeLocalizations":[{"currencyCode":"USD","prices":[{"model":"PAY_AS_YOU_GO","value":0.0138}]}]}]}
        with patch("rank.get_json",return_value=data):
            self.assertEqual(oracle_price("B112145"),0.0138)

    def test_bundle_score(self):
        self.assertAlmostEqual(rank_score({'vcpu':16, 'ram':32, 'hour_usd':0.0984}), 0.00615)
        self.assertAlmostEqual(rank_score({'vcpu':16, 'ram':16, 'hour_usd':0.08}), 0.01)
    def test_snapshot_contains_real_regional_quotes(self):
        rows, note = load_snapshot()
        self.assertGreater(len(rows), 200)
        self.assertTrue(any(r['provider']=='AWS' and r['geo']=='eu' for r in rows))
        self.assertTrue(any(r['provider']=='GCP' and r['geo']=='us' for r in rows))
        self.assertTrue(any(r['provider']=='OCI' and r['geo']=='global' for r in rows))
        self.assertTrue(all(r['geo'] in {'eu','us','global'} for r in rows))
        self.assertIn('Snapshot',note)

    def test_seed_is_consistent(self):
        rows = json.loads((ROOT/'data/seed.json').read_text())
        self.assertGreaterEqual(len(rows), 15)
        for r in rows:
            self.assertIn(r['provider'], {'OCI','AWS','GCP'})
            self.assertGreater(r['vcpu'], 0)
            self.assertGreater(r['ram'], 0)
            self.assertGreater(r['hour_usd'], 0)
            self.assertTrue(r['source'].startswith('https://'))
        best = min(rows,key=rank_score)
        self.assertEqual((best['provider'],best['family'],best['model']),('OCI','A4','Spot'))
if __name__ == '__main__': unittest.main()
