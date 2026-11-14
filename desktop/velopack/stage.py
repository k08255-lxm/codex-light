"""Stage an owned manifest and standalone worker; no app/worker execution."""
import argparse,hashlib,json,shutil,os
from pathlib import Path
WORKER='CodexLight.UpdateWorker'
WORKER_FILES=[WORKER+x for x in ('.exe','.dll','.deps.json','.runtimeconfig.json')]
def plain(path):
 for p in [path,*path.parents]:
  if getattr(os.stat(p,follow_symlinks=False),'st_file_attributes',0)&0x400 or p.is_symlink():raise ValueError('Reparse source')
def validate_worker(root,version):
 root=Path(root)
 for name in WORKER_FILES:
  p=root/name;plain(p)
  if not p.is_file():raise ValueError('Missing worker file: '+name)
 deps=json.loads((root/(WORKER+'.deps.json')).read_text(encoding='utf-8-sig'))
 runtime=json.loads((root/(WORKER+'.runtimeconfig.json')).read_text(encoding='utf-8-sig'))['runtimeOptions']
 if deps.get('runtimeTarget',{}).get('name')!='.NETCoreApp,Version=v10.0/win-x64':raise ValueError('Worker must target win-x64/net10')
 if set(deps.get('libraries',{}))!={WORKER+'/'+version}:raise ValueError('Worker version/dependencies mismatch')
 if runtime.get('tfm')!='net10.0' or runtime.get('includedFrameworks') or runtime.get('framework')!={'name':'Microsoft.NETCore.App','version':'10.0.0'}:raise ValueError('Worker must be framework-dependent net10.0')
 return WORKER_FILES

def stage(src,manifest,dst,worker,version):
 src,manifest,dst,worker=map(Path,(src,manifest,dst,worker))
 validate_worker(worker,version)
 items=json.loads(manifest.read_text(encoding='utf-8-sig'))
 for item in items:
  rel=Path(item['path'])
  if rel.is_absolute() or '..' in rel.parts or ':' in item['path']:raise ValueError('Unsafe manifest path')
  source=src/rel;target=dst/rel;plain(source)
  target.parent.mkdir(parents=True,exist_ok=True)
  shutil.copyfile(source,target)
  if hashlib.sha256(target.read_bytes()).hexdigest()!=item['sha256']:raise ValueError('Payload changed during staging')
 for name in WORKER_FILES:
  source=worker/name;target=dst/'update-worker'/name;target.parent.mkdir(exist_ok=True);plain(source)
  shutil.copyfile(source,target)
  if hashlib.sha256(source.read_bytes()).digest()!=hashlib.sha256(target.read_bytes()).digest():raise ValueError('Worker changed during staging')
 print('Staged verified files:',len(items)+len(WORKER_FILES))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('source');p.add_argument('manifest');p.add_argument('target');p.add_argument('worker');p.add_argument('version');a=p.parse_args();stage(a.source,a.manifest,a.target,a.worker,a.version)
