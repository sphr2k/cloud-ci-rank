import io, json, unittest, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from vantage import stream_json_array, quote_rows, allowed_region, region_group, best_by_geo, per_unit_score, fetch_vantage

class VantageTests(unittest.TestCase):
    def test_streaming_array_cross_chunk(self):
        arr=[{'instance_type':'c8g.4xlarge','pricing':{'us-east-1':{'linux':{'spot_avg':'0.2'}}}}, {'a':'ß' * 30}, {'x':2}]
        raw=json.dumps(arr,ensure_ascii=False).encode()
        self.assertEqual(list(stream_json_array(io.BytesIO(raw),chunk_size=7)), arr)
    def test_aws_spot_average_and_ondemand(self):
        record={'instance_type':'c8g.4xlarge','vCPU':16,'memory':32,'GPU':0,'arch':['arm64'],
                'physical_processor':'AWS Graviton4 Processor',
                'pricing':{'eu-central-1':{'linux':{'spot_avg':'0.295867','spot_min':'0.2955','spot_max':'0.2962','pct_interrupt':'<5%','ondemand':'0.7256'}}}}
        rows=quote_rows('AWS',record,'2026-10-25')
        self.assertEqual(len(rows),2)
        self.assertEqual(rows[0]['arch'],'ARM64')
        self.assertAlmostEqual(rows[0]['hour_usd'],0.295867)
        self.assertAlmostEqual(per_unit_score(rows[0]),0.295867/16)
        self.assertEqual(rows[0]['interruption'],'<5%')
    def test_gcp_spot(self):
        record={'instance_type':'c4a-highcpu-16','vCPU':16,'memory':32,'GPU':0,
                'pricing':{'europe-west3':{'linux':{'spot':'0.27776','ondemand':'0.715184'}}}}
        rows=quote_rows('GCP',record)
        self.assertEqual(rows[0]['arch'],'ARM64')
        self.assertEqual(rows[0]['model'],'Spot')
        self.assertAlmostEqual(rows[0]['hour_usd'],0.27776)
    def test_geographic_scope(self):
        examples = [
            ('AWS','eu-central-1','eu'), ('AWS','eu-west-3','eu'),
            ('AWS','us-east-2','us'), ('AWS','ap-south-2',None),
            ('AWS','us-gov-west-1',None), ('AWS','cn-north-1',None),
            ('GCP','europe-west3','eu'),('GCP','europe-north1','eu'),
            ('GCP','us-west8','us'), ('GCP','asia-south2',None),
            ('GCP','australia-southeast1',None)
        ]
        for provider, region, expected in examples:
            with self.subTest(provider=provider,region=region):
                self.assertEqual(region_group(provider,region), expected)

    def test_dont_collapse_regions_before_ui(self):
        common = dict(provider='GCP',instance='c3d-highcpu-16',family='c3d-highcpu',
                      model='Spot',arch='x86-64',vcpu=16,ram=32)
        rows=[dict(common,geo='eu',region='europe-west3',hour_usd=0.3),
              dict(common,geo='us',region='us-east5',hour_usd=0.1),
              dict(common,geo='eu',region='europe-north1',hour_usd=0.25)]
        kept=best_by_geo(rows)
        self.assertEqual(len(kept),2)
        self.assertEqual({r['geo']:r['region'] for r in kept}, {'eu':'europe-north1','us':'us-east5'})


    def test_size_variants_survive_pregrouping_for_max_vcpu_filter(self):
        common = dict(provider='GCP', family='c3d-highcpu', model='Spot',
                      arch='x86-64', geo='eu', region='europe-west3')
        rows = [dict(common, instance='c3d-highcpu-16', vcpu=16, ram=32, hour_usd=0.30),
                dict(common, instance='c3d-highcpu-32', vcpu=32, ram=64, hour_usd=0.40)]
        retained = best_by_geo(rows)
        self.assertEqual(len(retained), 2)
        under_cap = [r for r in retained if r['vcpu'] <= 16]
        self.assertEqual(len(under_cap), 1)
        self.assertEqual(under_cap[0]['instance'], 'c3d-highcpu-16')

    def test_live_fetch_keeps_size_variants(self):
        from unittest.mock import patch
        def fake_shape(name, cpu):
            return {'instance_type':name, 'vCPU':cpu, 'memory':cpu*2, 'GPU':0,
                    'pricing':{'europe-west3':{'linux':{'spot':str(cpu*0.01)}}}}
        with patch('vantage.get_instances', return_value=iter([
            fake_shape('c3d-highcpu-16',16), fake_shape('c3d-highcpu-32',32)
        ])):
            rows, parsed = fetch_vantage('GCP')
        self.assertEqual(parsed, 2)
        self.assertEqual({r['vcpu'] for r in rows}, {16,32})

    def test_nonregular_exclusion(self):
        self.assertFalse(allowed_region('cn-north-1'))
        self.assertFalse(allowed_region('us-gov-west-1'))
        self.assertTrue(allowed_region('us-east-1'))
        record={'instance_type':'t4g.2xlarge','vCPU':8,'memory':32,'pricing':{'us-east-1':{'linux':{'ondemand':'0.1'}}}}
        self.assertEqual(quote_rows('AWS',record),[])
        record['instance_type']='inf1.2xlarge'
        self.assertEqual(quote_rows('AWS',record),[])

if __name__=='__main__':unittest.main()
