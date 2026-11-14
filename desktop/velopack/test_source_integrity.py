import tempfile,unittest,shutil
from pathlib import Path
from source_integrity import verify
class Tests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.r=Path(self.t.name)/'repo';self.p=Path(self.t.name)/'payload'
  for n in ['src/backend-health.mjs','public/app.js','package.json','components/dsh-bridge/dist/bridge.js','components/dsh-bridge/node_modules/pkg/index.d.ts']:
   p=self.r/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('{"version":"0.4.3"}' if n=='package.json' else 'current')
  shutil.copytree(self.r,self.p/'app')
 def tearDown(self):self.t.cleanup()
 def test_valid(self):self.assertEqual(verify(self.r,self.p)['FileCount'],5)
 def test_same_version_stale(self):
  (self.p/'app/src/backend-health.mjs').write_text('old')
  with self.assertRaises(ValueError):verify(self.r,self.p)
 def test_missing(self):
  (self.p/'app/src/backend-health.mjs').unlink()
  with self.assertRaises(ValueError):verify(self.r,self.p)
 def test_extra(self):
  (self.p/'app/unknown.txt').write_text('extra')
  with self.assertRaises(ValueError):verify(self.r,self.p)
 def test_current_build_output(self):
  (self.r/'components/dsh-bridge/dist/bridge.js').write_text('new build')
  with self.assertRaises(ValueError):verify(self.r,self.p)
 def test_filtered_policy(self):
  (self.p/'app/components/dsh-bridge/node_modules/pkg/index.d.ts').unlink();self.assertEqual(verify(self.r,self.p,True)['FileCount'],4)
 def test_fingerprint_changes(self):
  old=verify(self.r,self.p)['TreeSha256'];(self.r/'public/app.js').write_text('new');(self.p/'app/public/app.js').write_text('new');self.assertNotEqual(old,verify(self.r,self.p)['TreeSha256'])
if __name__=='__main__':unittest.main()
