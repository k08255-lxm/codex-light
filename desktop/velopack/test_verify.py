import hashlib,json,tempfile,unittest,zipfile
from pathlib import Path
from verify import verify,ID
class VerificationTests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.root=Path(self.t.name);self.p=self.root/'payload';self.r=self.root/'release';self.p.mkdir();self.r.mkdir();self.v='0.4.3'
  for name in ('Velopack.dll','licenses/Velopack-LICENSE.txt','licenses/Velopack-VENDOR-NOTICES.md','app/package.json','CodexLight.exe'):
   f=self.p/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(name.encode())
  worker=self.p/'update-worker';worker.mkdir()
  (worker/'CodexLight.UpdateWorker.exe').write_bytes(b'MZfixture')
  (worker/'CodexLight.UpdateWorker.dll').write_bytes(b'fixture-dll')
  (worker/'CodexLight.UpdateWorker.deps.json').write_text(json.dumps({'runtimeTarget':{'name':'.NETCoreApp,Version=v10.0/win-x64'},'libraries':{'CodexLight.UpdateWorker/'+self.v:{}}}))
  (worker/'CodexLight.UpdateWorker.runtimeconfig.json').write_text(json.dumps({'runtimeOptions':{'tfm':'net10.0','framework':{'name':'Microsoft.NETCore.App','version':'10.0.0'}}}))
  self.pkg=self.r/f'{ID}-{self.v}-full.nupkg';self.port=self.r/f'{ID}-win-Portable.zip';self.exe=self.r/f'{ID}-win-Setup.exe'
  with zipfile.ZipFile(self.pkg,'w') as z:
   for f in self.p.rglob('*'):
    if f.is_file():z.writestr('lib/app/'+f.relative_to(self.p).as_posix(),f.read_bytes())
   z.writestr('lib/app/sq.version',f'<package><metadata><id>{ID}</id><version>{self.v}</version><mainExe>CodexLight.exe</mainExe></metadata></package>')
  with zipfile.ZipFile(self.port,'w') as z:
   z.writestr('.portable','');z.writestr('Update.exe','MZ')
   for f in self.p.rglob('*'):
    if f.is_file():z.writestr('current/'+f.relative_to(self.p).as_posix(),f.read_bytes())
  self.refresh()
 def tearDown(self):self.t.cleanup()
 def refresh(self):
  b=self.pkg.read_bytes();self.exe.write_bytes(b'MZ'+b)
  self.feed={'Assets':[dict(PackageId=ID,Version=self.v,Type='Full',FileName=self.pkg.name,Size=len(b),SHA1=hashlib.sha1(b).hexdigest().upper(),SHA256=hashlib.sha256(b).hexdigest().upper())]}
  self.savefeed()
 def savefeed(self):(self.r/'releases.win.json').write_text(json.dumps(self.feed))
 def test_valid(self):self.assertTrue(verify(self.r,self.p,self.v)['allPayloadHashesMatch'])
 def test_wrong_feed_hash(self):
  self.feed['Assets'][0]['SHA256']='0'*64;self.savefeed()
  with self.assertRaises(ValueError):verify(self.r,self.p,self.v)
 def test_delta_refused(self):
  (self.r/'unexpected-delta.nupkg').write_bytes(b'x')
  with self.assertRaises(ValueError):verify(self.r,self.p,self.v)
 def test_source_tamper(self):
  (self.p/'CodexLight.exe').write_bytes(b'changed')
  with self.assertRaises(ValueError):verify(self.r,self.p,self.v)
 def test_unknown_zip_payload(self):
  with zipfile.ZipFile(self.pkg,'a') as z:z.writestr('lib/app/secrets.txt','private')
  self.refresh()
  with self.assertRaises(ValueError):verify(self.r,self.p,self.v)
 def test_zip_traversal(self):
  with zipfile.ZipFile(self.pkg,'a') as z:z.writestr('../escape','private')
  self.refresh()
  with self.assertRaises(ValueError):verify(self.r,self.p,self.v)
 def test_setup_wrong_package(self):
  self.exe.write_bytes(b'MZnot-this-package')
  with self.assertRaises(ValueError):verify(self.r,self.p,self.v)
 def test_wrong_identity(self):
  self.feed['Assets'][0]['PackageId']='CodexLight';self.savefeed()
  with self.assertRaises(ValueError):verify(self.r,self.p,self.v)
 def test_worker_missing(self):
  (self.p/'update-worker/CodexLight.UpdateWorker.dll').unlink()
  with self.assertRaises((ValueError,FileNotFoundError)):verify(self.r,self.p,self.v)
 def test_worker_wrong_version(self):
  p=self.p/'update-worker/CodexLight.UpdateWorker.deps.json';d=json.loads(p.read_text());d['libraries']={'CodexLight.UpdateWorker/1.0.0':{}};p.write_text(json.dumps(d))
  with self.assertRaises(ValueError):verify(self.r,self.p,self.v)
 def test_worker_selfcontained(self):
  p=self.p/'update-worker/CodexLight.UpdateWorker.runtimeconfig.json';d=json.loads(p.read_text());d['runtimeOptions']['includedFrameworks']=[{'name':'Microsoft.NETCore.App','version':'10.0.0'}];p.write_text(json.dumps(d))
  with self.assertRaises(ValueError):verify(self.r,self.p,self.v)
 def test_worker_extra_content(self):
  (self.p/'update-worker/private.txt').write_text('no')
  with self.assertRaises(ValueError):verify(self.r,self.p,self.v)
if __name__=='__main__':unittest.main()
