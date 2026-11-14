import tempfile,unittest,shutil,json,hashlib
from pathlib import Path
from source_integrity import verify
from bridge_bundle import SOURCE_SCOPES,source_inventory
class Tests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.r=Path(self.t.name)/'repo';self.p=Path(self.t.name)/'payload'
  for n in ['src/backend-health.mjs','public/app.js','package.json','components/dsh-bridge/src/light-entry.mjs']:
   p=self.r/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('{"version":"0.4.3"}' if n=='package.json' else 'current')
  b=self.r/'components/dsh-bridge';d=b/'dist';d.mkdir();
  for n in ['LICENSE','package.json','package-lock.json','entry.mjs','licenses.json']: (d/n).write_text('current')
  h=lambda x:hashlib.sha256(x).hexdigest()
  for scope in SOURCE_SCOPES:
   f=b/(scope+'/fixture.js' if scope in ('src','assets','licenses') else scope);f.parent.mkdir(parents=True,exist_ok=True);f.write_text('source')
  sources={n:h(f.read_bytes()) for n,f in sorted(source_inventory(b).items())}
  m={'format':'codex-light-dsh-bundle-v1','component':'codex-light-dsh-bridge','entry':'entry.mjs','licenses':'licenses.json','lockSha256':h(b'current'),'sourceFiles':sources,'sourceSha256':h(json.dumps(sources,separators=(',',':')).encode()),'files':{f.name:h(f.read_bytes()) for f in d.iterdir()}}
  (d/'manifest.json').write_text(json.dumps(m))
  for n in ['src','public']:shutil.copytree(self.r/n,self.p/'app'/n)
  shutil.copyfile(self.r/'package.json',self.p/'app/package.json')
  shutil.copytree(d,self.p/'app/components/dsh-bridge')
 def tearDown(self):self.t.cleanup()
 def test_valid(self):self.assertEqual(verify(self.r,self.p)['FileCount'],9)
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
  (self.r/'components/dsh-bridge/dist/entry.mjs').write_text('new build')
  with self.assertRaises(ValueError):verify(self.r,self.p)
 def test_filtered_policy(self):
  self.assertEqual(verify(self.r,self.p,True)['FileCount'],9)
 def test_fingerprint_changes(self):
  old=verify(self.r,self.p)['TreeSha256'];(self.r/'public/app.js').write_text('new');(self.p/'app/public/app.js').write_text('new');self.assertNotEqual(old,verify(self.r,self.p)['TreeSha256'])
if __name__=='__main__':unittest.main()
