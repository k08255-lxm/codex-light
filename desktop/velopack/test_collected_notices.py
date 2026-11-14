import os,shutil,tempfile,unittest
from pathlib import Path
from collected_notices import consolidate,validate,read,collect,NAME

class CollectedStageGuardTests(unittest.TestCase):
 def test_refuses_implicit_destructive_stage(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t);(p/'sentinel').write_text('keep')
   with self.assertRaises(ValueError):consolidate(p)
   self.assertEqual((p/'sentinel').read_text(),'keep')

@unittest.skipUnless(os.environ.get('CODECANG_TEST_COLLECTED_PAYLOAD'),'build a collected payload first')
class ActualCollectedPayloadTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  source=Path(os.environ['CODECANG_TEST_COLLECTED_PAYLOAD'])
  for n in ('LICENSE','THIRD-PARTY-NOTICES.txt'):shutil.copyfile(source/n,self.root/n)
  shutil.copytree(source/'app/components/dsh-bridge',self.root/'app/components/dsh-bridge')
 def tearDown(self):self.tmp.cleanup()
 def test_actual_collected_payload(self):self.assertGreater(len(validate(self.root)),195)
 def test_native_copyright_cannot_be_dropped_even_with_reindexed_container(self):
  p=self.root/'THIRD-PARTY-NOTICES.txt';items=read(p.read_bytes())
  n=next(n for n in items if n.startswith(NAME+'/') and 'LICENSE' in n)
  items[n]=b'MIT without original copyright';p.write_bytes(collect(items))
  with self.assertRaises(ValueError):validate(self.root)
 def test_project_and_mixed_layout_rejected(self):
  (self.root/'LICENSE').write_text('changed')
  with self.assertRaises(ValueError):validate(self.root)
  (self.root/'licenses').mkdir();(self.root/'licenses/extra').write_text('unexpected')
  with self.assertRaises(ValueError):validate(self.root)
if __name__=='__main__':unittest.main()
