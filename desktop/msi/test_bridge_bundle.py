import hashlib,json,tempfile,unittest
from pathlib import Path
from bridge_bundle import validate,SOURCE_SCOPES,source_inventory
class BundleTests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.r=Path(self.t.name);self.d=self.r/'dist';self.d.mkdir();(self.r/'source.js').write_text('source')
  for n in ['LICENSE','package.json','package-lock.json','entry.mjs','licenses.json']:(self.d/n).write_text('current')
  for scope in SOURCE_SCOPES:
   f=self.r/(scope+'/fixture.js' if scope in ('src','assets','licenses') else scope);f.parent.mkdir(parents=True,exist_ok=True);f.write_text('source')
  h=lambda b:hashlib.sha256(b).hexdigest();src={n:h(f.read_bytes()) for n,f in sorted(source_inventory(self.r).items())}
  self.m={'format':'codex-light-dsh-bundle-v1','component':'codex-light-dsh-bridge','entry':'entry.mjs','licenses':'licenses.json','lockSha256':h(b'current'),'files':{f.name:h(f.read_bytes()) for f in self.d.iterdir()},'sourceFiles':src,'sourceSha256':h(json.dumps(src,separators=(',',':')).encode())};self.save()
 def save(self):(self.d/'manifest.json').write_text(json.dumps(self.m))
 def tearDown(self):self.t.cleanup()
 def test_exact(self):self.assertEqual(len(validate(self.d,self.r)),6)
 def test_extra(self):
  (self.d/'secret.txt').write_text('x')
  with self.assertRaises(ValueError):validate(self.d)
 def test_missing(self):
  (self.d/'LICENSE').unlink()
  with self.assertRaises(ValueError):validate(self.d)
 def test_modified(self):
  (self.d/'entry.mjs').write_text('wrong')
  with self.assertRaises(ValueError):validate(self.d)
 def test_stale_source(self):
  (self.r/'src/fixture.js').write_text('new')
  with self.assertRaises(ValueError):validate(self.d,self.r)
 def test_added_unbundled_source(self):
  (self.r/'src/new.js').write_text('new')
  with self.assertRaises(ValueError):validate(self.d,self.r)
 def test_missing_source_scope(self):
  (self.r/'bundle.mjs').unlink()
  with self.assertRaises((ValueError,FileNotFoundError)):validate(self.d,self.r)
 def test_fingerprint(self):
  self.m['sourceSha256']='0'*64;self.save()
  with self.assertRaises(ValueError):validate(self.d)
 def test_path_traversal(self):
  self.m['files']['../x']='0'*64;self.save()
  with self.assertRaises(ValueError):validate(self.d)
 def test_case_collision(self):
  self.m['files']['license']=self.m['files']['LICENSE'];self.save()
  with self.assertRaises(ValueError):validate(self.d)
 def test_wrong_format(self):
  self.m['format']='old';self.save()
  with self.assertRaises(ValueError):validate(self.d)
if __name__=='__main__':unittest.main()
