"""Validate compact DSH distribution before copying or authoring installers."""
import hashlib,json,re
from pathlib import Path,PurePosixPath

SOURCE_SCOPES=('src','assets','licenses','LICENSE','README.md','THIRD-PARTY-NOTICES.md','package.json','package-lock.json','manifest.json','build.mjs','bundle.mjs','tools/package.json','tools/package-lock.json')
def source_inventory(root):
 result={}
 for scope in SOURCE_SCOPES:
  p=root/scope;plain(p)
  if p.is_dir():result.update({scope+'/'+n:f for n,f in inventory(p).items()})
  elif p.is_file():result[scope]=p
  else:raise ValueError('Missing bridge source scope: '+scope)
 return result
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def plain(p):
 for f in [p,*p.parents]:
  if f.is_symlink() or getattr(f.lstat(),'st_file_attributes',0)&0x400:raise ValueError('Reparse bundle entry: '+str(f))
def safe(name):
 if not isinstance(name,str) or not name or '\\' in name or ':' in name or name.startswith('/') or any(x in ('','..','.') for x in name.split('/')):raise ValueError('Unsafe bundle path')
 return name
def inventory(root):
 plain(root);out={}
 for p in root.rglob('*'):
  plain(p)
  if p.is_file():out[p.relative_to(root).as_posix()]=p
 return out
def mapping(value):
 if not isinstance(value,dict) or not value:raise ValueError('Missing hash inventory')
 for n,h in value.items():
  safe(n)
  if not isinstance(h,str) or not re.fullmatch('[0-9a-f]{64}',h):raise ValueError('Invalid hash')
 if len({n.lower() for n in value})!=len(value):raise ValueError('Case ambiguous paths')
 return value
def validate(root,source=None):
 root=Path(root);actual=inventory(root)
 m=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
 if m.get('format')!='codex-light-dsh-bundle-v1' or m.get('component')!='codex-light-dsh-bridge':raise ValueError('Unsupported bridge distribution')
 files=mapping(m.get('files'));sources=mapping(m.get('sourceFiles'))
 if set(files)|{'manifest.json'}!=set(actual) or 'manifest.json' in files:raise ValueError('Bundle file inventory mismatch')
 for n,h in files.items():
  if sha(actual[n])!=h:raise ValueError('Modified bundle file: '+n)
 for n in ('LICENSE','package.json','package-lock.json',m.get('entry'),m.get('licenses')):
  if safe(n) not in files:raise ValueError('Required bridge payload absent')
 if sha(root/'package-lock.json')!=m.get('lockSha256'):raise ValueError('Bridge lock mismatch')
 canonical=json.dumps(dict(sorted(sources.items())),ensure_ascii=False,separators=(',',':')).encode()
 if hashlib.sha256(canonical).hexdigest()!=m.get('sourceSha256'):raise ValueError('Source fingerprint mismatch')
 if source is not None:
  source=Path(source)
  if set(source_inventory(source))!=set(sources):raise ValueError('Source inventory mismatch')
  for n,h in sources.items():
   p=source/n;plain(p)
   if not p.is_file() or sha(p)!=h:raise ValueError('Stale bridge source: '+n)
 return actual
if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('root');p.add_argument('--source');a=p.parse_args();print('Verified bridge bundle files:',len(validate(a.root,a.source)))
