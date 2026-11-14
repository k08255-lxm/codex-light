import tempfile,shutil,json,unittest
from pathlib import Path
from native_notices import validate,ROOT
class NativeNoticesTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)/'notices';shutil.copytree(ROOT,self.root)
 def tearDown(self):self.tmp.cleanup()
 def test_valid(self):self.assertEqual(validate(self.root),194)
 def test_missing(self):
  (self.root/'rust-1.97.1/LICENSE-MIT').unlink()
  with self.assertRaises((ValueError,FileNotFoundError)):validate(self.root)
 def test_modified(self):
  (self.root/'README.md').write_text('tampered')
  with self.assertRaises(ValueError):validate(self.root)
 def test_unsafe_manifest(self):
  p=self.root/'files.sha256.json';m=json.loads(p.read_text());m[0]['path']='../escape';p.write_text(json.dumps(m))
  with self.assertRaises(ValueError):validate(self.root)
 def test_vendor_mismatch(self):
  v=Path(self.tmp.name)/'vendor';v.mkdir()
  for name in ['update_x64.exe','setup_x64.exe','stub_x64.exe']:(v/name).write_bytes(b'MZchanged')
  with self.assertRaises(ValueError):validate(self.root,v)
if __name__=='__main__':unittest.main()
