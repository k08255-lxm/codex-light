#!/usr/bin/env python3
"""Reproduce vendored ESM from two official npm tarballs. No install scripts."""
import hashlib,tarfile,sys,pathlib,re
root=pathlib.Path(__file__).resolve().parents[1]
spec=[('xterm-xterm-6.0.0.tgz','908e66e04af6c8dc6b00dd3b54de088e2e81e5ed866284fd6c2fb3c2d1c7a3f6',{'package/lib/xterm.mjs':'public/vendor/xterm.mjs','package/css/xterm.css':'public/vendor/xterm.css','package/LICENSE':'licenses/xterm/LICENSE'}),('xterm-addon-fit-0.11.0.tgz','26003b4517a132b64e4ff228fd88a5fda3fff5e606c76093f6dcff772e9ecec0',{'package/lib/addon-fit.mjs':'public/vendor/addon-fit.mjs','package/LICENSE':'licenses/xterm/addon-fit-LICENSE'})]
for name,digest,mapping in spec:
 archive=pathlib.Path(sys.argv[1])/name
 assert hashlib.sha256(archive.read_bytes()).hexdigest()==digest,'Official tarball hash mismatch'
 with tarfile.open(archive) as tar:
  for member,dest in mapping.items():
   data=tar.extractfile(member).read()
   if dest.endswith('/xterm.mjs'):
    source=data.decode();source,count=re.subn(r'(n.mainDocument|this._document)\.createElement\("style"\)',r'codexLightStyle(\1)',source);assert count==3
    source='function codexLightStyle(doc){const el=doc.createElement("style");const nonce=doc.querySelector(\'meta[name="codex-light-style-nonce"]\')?.content;if(nonce)el.nonce=nonce;return el;}\n'+source
    data=source.encode()
   target=root/dest;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
