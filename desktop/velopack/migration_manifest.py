"""Build a non-publishing migration-stage manifest from verified official pack output."""
import argparse,json,re,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET
from verify import archive,sha,ID
from stage import plain
PIN='1.3.39-g8d2844f'

def generate(release,version):
 r=Path(release);plain(r)
 if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)',version):raise ValueError('Invalid target version')
 dst=r/'migration-current';manifest=r/'migration-release.json'
 if dst.exists() or manifest.exists():raise ValueError('Never overwrite stage manifest or current tree')
 package=r/f'{ID}-{version}-full.nupkg';setup=r/f'{ID}-win-Setup.exe';prereq=r/'prerequisites/CodexLight.NodePrerequisite.exe'
 for f in (package,setup,prereq):plain(f)
 data=package.read_bytes();exe=setup.read_bytes()
 if not exe.startswith(b'MZ') or exe.find(data)<0:raise ValueError('Setup must embed exact full package')
 with zipfile.ZipFile(package) as z:
  names=archive(z);meta=ET.fromstring(z.read('lib/app/sq.version'));m={e.tag.rsplit('}',1)[-1]:e.text for e in meta.iter()}
  if any(m.get(k)!=v for k,v in {'id':ID,'version':version,'mainExe':'CodexLight.exe','shortcutLocations':'None'}.items()):raise ValueError('Stage package identity/version/shortcuts mismatch')
  deps=json.loads(z.read('lib/app/CodexLight.deps.json'))
  if 'Velopack/'+PIN not in deps.get('libraries',{}):raise ValueError('Wrong runtime pin')
  source=json.loads(z.read('lib/app/source-tree.json'))
  if source.get('Schema')!=1 or not re.fullmatch(r'[0-9a-f]{64}',source.get('TreeSha256','')):raise ValueError('Source fingerprint missing or invalid')
  updater=z.read('lib/app/Squirrel.exe');stub=z.read('lib/app/Codex Light_ExecutionStub.exe')
  with zipfile.ZipFile(r/f'{ID}-win-Portable.zip') as portable:
   archive(portable)
   if sha(portable.read('Update.exe'))!=sha(updater) or sha(portable.read('Codex Light.exe'))!=sha(stub):raise ValueError('Updater/stub extraction mapping mismatch')
  payload=[]
  for name in sorted(names):
   if not name.startswith('lib/app/') or name.endswith('/') or name in ('lib/app/Squirrel.exe','lib/app/Codex Light_ExecutionStub.exe'):continue
   relative=name[8:];b=z.read(name);payload.append((relative,b))
  if dict(payload).get('prerequisites/CodexLight.NodePrerequisite.exe')!=prereq.read_bytes():raise ValueError('Sidecar prerequisite differs from package')
  config=r/'prerequisites/CodexLight.NodePrerequisite.exe.config';plain(config)
  if dict(payload).get('prerequisites/CodexLight.NodePrerequisite.exe.config')!=config.read_bytes():raise ValueError('Sidecar config differs from package')
 dst.mkdir()
 for name,b in payload:
  f=dst/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(b)
 warning=r/'MIGRATION-STAGE-ONLY.txt';warning.write_text('Staging-only artifact: no shortcuts, not a final public installer/release. Requires trusted manifest/setup SHA and migration review. Never retire MSI automatically.\n')
 files=[]
 for f in sorted(r.rglob('*')):
  plain(f)
  if f.is_file() and f.name not in ('migration-release.json','SHA256SUMS.txt'):
   b=f.read_bytes();files.append({'Path':f.relative_to(r).as_posix(),'Bytes':len(b),'Sha256':sha(b)})
 result={'Schema':1,'PackageId':ID,'Version':version,'TargetVersion':version,'VelopackVersion':PIN,'Shortcuts':'None','StageOnly':True,'AllowSameVersion':True,'Setup':setup.name,'SetupSha256':sha(exe),'FullPackage':package.name,'FullPackageSha256':sha(data),'Prerequisite':prereq.relative_to(r).as_posix(),'PayloadDirectory':dst.name,'SourceTreeFingerprint':source['TreeSha256'],'RootUpdaterSha256':sha(updater),'RootStubPath':'Codex Light.exe','RootStubSha256':sha(stub),'Files':files,'PayloadFiles':[{'Path':n,'Bytes':len(b),'Sha256':sha(b)} for n,b in payload]}
 manifest.write_text(json.dumps(result,indent=2),encoding='utf-8')
 return {'manifest':str(manifest),'manifestSha256':sha(manifest.read_bytes()),'setupSha256':sha(exe),'files':len(files),'payloadFiles':len(payload)}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('release');p.add_argument('version');a=p.parse_args();print(json.dumps(generate(a.release,a.version),indent=2))
