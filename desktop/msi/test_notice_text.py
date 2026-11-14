import unittest,subprocess,json
from pathlib import Path
from notice_text import collect,read
class NoticeTextTests(unittest.TestCase):
 def test_exact_cross_language(self):
  items={'a/LICENSE':'Copyright Alice\r\n鍏ㄦ枃\r\n'.encode(),'b/NOTICE':b'Copyright Bob\n','c/LICENSE':'Copyright Alice\r\n鍏ㄦ枃\r\n'.encode()}
  data=collect(items);self.assertEqual(read(data),items);self.assertEqual(data.count(b'Copyright Alice'),1)
  root=Path(__file__).resolve().parents[2]
  script="import {collectNoticeText} from './src/notice-text.mjs';const data=JSON.parse(process.argv[1]);process.stdout.write(collectNoticeText(Object.fromEntries(Object.entries(data).map(([n,b])=>[n,Buffer.from(b,'hex')]))));"
  js=subprocess.check_output(['node','--input-type=module','-e',script,json.dumps({n:b.hex() for n,b in items.items()})],cwd=root)
  self.assertEqual(js,data)
 def test_bad_inputs(self):
  for x in ({'../x':b'x'},{'A':b'x','a':b'x'},{'x':b''},{'x':b'\xff'}):
   with self.assertRaises((ValueError,UnicodeError)):collect(x)
 def test_corruption(self):
  data=collect({'LICENSE':b'copyright retained'})
  with self.assertRaises(ValueError):read(data[:-1]+b'!')
  with self.assertRaises(ValueError):read(data+b'junk')
if __name__=='__main__':unittest.main()
