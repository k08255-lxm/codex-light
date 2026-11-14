"""Reject same-version stale payloads by exact current source-tree byte identity."""
import argparse,hashlib,json,sys
from pathlib import Path
from stage import plain
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'msi'))
from payload_policy import omitted_runtime_file
from bridge_bundle import validate as validate_bridge_bundle
SCOPES=('src','public','package.json','components/dsh-bridge')
def digest(b):return hashlib.sha256(b).hexdigest()
def entry_plain(p):
 if p.is_symlink() or getattr(p.lstat(),'st_file_attributes',0)&0x400:raise ValueError('Reparse entry refused: '+str(p))
def collect(root):
 result={}
 for scope in SCOPES:
  p=root/scope;plain(p)
  if not p.exists():raise ValueError('Missing source scope: '+scope)
  if scope=='components/dsh-bridge':
   for name,f in validate_bridge_bundle(p/'dist',p).items():result[scope+'/'+name]=f
   continue
  for f in ([p] if p.is_file() else p.rglob('*')):
   entry_plain(f)
   if f.is_file():result[f.relative_to(root).as_posix()]=f
 return result
def verify(repo,payload,filtered=False):
 repo=Path(repo);payload=Path(payload);expected=collect(repo);app=payload/'app';plain(app)
 actual={}
 for f in app.rglob('*'):
  entry_plain(f)
  if f.is_file():actual[f.relative_to(app).as_posix()]=f
 if filtered:expected={n:f for n,f in expected.items() if n.startswith('components/dsh-bridge/') or not omitted_runtime_file('app/'+n)}
 missing=expected.keys()-actual.keys();extra=actual.keys()-expected.keys()
 if missing or extra:raise ValueError('Source/payload paths differ; missing='+str(sorted(missing)[:10])+' extra='+str(sorted(extra)[:10]))
 entries=[]
 for name,f in sorted(expected.items()):
  b=f.read_bytes();h=digest(b)
  if digest(actual[name].read_bytes())!=h:raise ValueError('Stale/modified payload: '+name)
  entries.append({'Path':name,'Bytes':len(b),'Sha256':h})
 encoded=json.dumps(entries,separators=(',',':'),ensure_ascii=False).encode('utf-8')
 return {'Schema':1,'Scopes':list(SCOPES),'FilteredRuntimeDeclarations':filtered,'FileCount':len(entries),'TreeSha256':digest(encoded),'Files':entries}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('repo');p.add_argument('payload');p.add_argument('--filtered',action='store_true');p.add_argument('--output');a=p.parse_args();r=verify(a.repo,a.payload,a.filtered);s=json.dumps(r,indent=2)
 if a.output:Path(a.output).write_text(s,encoding='utf-8')
 else:print(s)
