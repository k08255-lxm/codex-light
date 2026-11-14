import unittest,tempfile,json,zipfile
from pathlib import Path
from migration_manifest import generate,PIN,ID
class StageTests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.r=Path(self.t.name);self.version='0.4.3'
  (self.r/'prerequisites').mkdir();self.exe=self.r/f'{ID}-win-Setup.exe';self.pkg=self.r/f'{ID}-0.4.3-full.nupkg'
  self.payload={'sq.version':f'<package><id>{ID}</id><version>0.4.3</version><mainExe>CodexLight.exe</mainExe><shortcutLocations>None</shortcutLocations></package>'.encode(),'CodexLight.deps.json':json.dumps({'libraries':{'Velopack/'+PIN:{}}}).encode(),'CodexLight.exe':b'MZhost','Squirrel.exe':b'MZupdate','Codex Light_ExecutionStub.exe':b'MZstub','prerequisites/CodexLight.NodePrerequisite.exe':b'MZhelper','prerequisites/CodexLight.NodePrerequisite.exe.config':b'config'}
  for k,v in self.payload.items():
   if k.startswith('prerequisites/'):(self.r/k).write_bytes(v)
  self.payload['source-tree.json']=json.dumps({'Schema':1,'TreeSha256':'a'*64}).encode()
  self.pack()
 def tearDown(self):self.t.cleanup()
 def pack(self):
  with zipfile.ZipFile(self.pkg,'w') as z:
   for k,v in self.payload.items():z.writestr('lib/app/'+k,v)
  self.exe.write_bytes(b'MZ'+self.pkg.read_bytes())
  with zipfile.ZipFile(self.r/f'{ID}-win-Portable.zip','w') as z:z.writestr('Update.exe',b'MZupdate');z.writestr('Codex Light.exe',b'MZstub')
 def test_valid(self):
  result=generate(self.r,self.version);m=json.loads((self.r/'migration-release.json').read_text());self.assertEqual(result['payloadFiles'],6);self.assertTrue(m['StageOnly']);self.assertEqual(m['TargetVersion'],'0.4.3');self.assertTrue((self.r/'migration-current/sq.version').exists());self.assertFalse((self.r/'migration-current/Squirrel.exe').exists())
 def test_shortcuts_rejected(self):
  self.payload['sq.version']=self.payload['sq.version'].replace(b'None',b'StartMenuRoot');self.pack()
  with self.assertRaises(ValueError):generate(self.r,self.version)
 def test_setup_mismatch(self):
  self.exe.write_bytes(b'MZother')
  with self.assertRaises(ValueError):generate(self.r,self.version)
 def test_helper_mismatch(self):
  (self.r/'prerequisites/CodexLight.NodePrerequisite.exe').write_bytes(b'tampered')
  with self.assertRaises(ValueError):generate(self.r,self.version)
 def test_runtime_pin(self):
  self.payload['CodexLight.deps.json']=b'{"libraries":{"Velopack/1.2.161":{}}}';self.pack()
  with self.assertRaises(ValueError):generate(self.r,self.version)
 def test_no_overwrite(self):
  generate(self.r,self.version)
  with self.assertRaises(ValueError):generate(self.r,self.version)
 def test_traversal(self):
  self.payload['../bad']=b'x';self.pack()
  with self.assertRaises(ValueError):generate(self.r,self.version)
if __name__=='__main__':unittest.main()
