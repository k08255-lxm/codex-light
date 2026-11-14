"""Read-only full-package/portable/setup verification. Never execute release binaries."""
import argparse, hashlib, json, re, zipfile
from pathlib import Path, PurePosixPath
import xml.etree.ElementTree as ET
from stage import validate_worker,WORKER_FILES

ID = 'CodexLightDesktop'
def sha(data): return hashlib.sha256(data).hexdigest()
def archive(z):
    names=z.namelist()
    if len(names)!=len(set(n.casefold() for n in names)):
        raise ValueError('Duplicate ZIP entries')
    for n in names:
        if n.startswith('/') or '\\' in n or ':' in n or '..' in PurePosixPath(n).parts:
            raise ValueError('Unsafe ZIP path')
    return set(names)
def verify(release, payload, version, manifest=None):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)',version): raise ValueError('Invalid version')
    release=Path(release);payload=Path(payload)
    package=release/f'{ID}-{version}-full.nupkg'
    portable=release/f'{ID}-win-Portable.zip';setup=release/f'{ID}-win-Setup.exe'
    data=package.read_bytes()
    feed=json.loads((release/'releases.win.json').read_text(encoding='utf-8-sig'))
    assets=feed['Assets']
    if len(assets)!=1:raise ValueError('Full-only release must have one asset')
    a=assets[0]
    expected={'PackageId':ID,'Version':version,'Type':'Full','FileName':package.name,'Size':len(data),'SHA256':sha(data).upper(),'SHA1':hashlib.sha1(data).hexdigest().upper()}
    for k,v in expected.items():
        if a.get(k)!=v:raise ValueError('Feed mismatch: '+k)
    if list(release.glob('*-delta.nupkg')):raise ValueError('Unexpected delta package')
    files={f.relative_to(payload).as_posix():f for f in payload.rglob('*') if f.is_file()}
    for f in files.values():
        if f.is_symlink():raise ValueError('Payload link')
    if not {'Velopack.dll','licenses/Velopack-LICENSE.txt','licenses/Velopack-VENDOR-NOTICES.md','app/package.json','CodexLight.exe'}<=files.keys():raise ValueError('Missing runtime/licenses')
    validate_worker(payload/'update-worker',version)
    if {n for n in files if n.startswith('update-worker/')} != {'update-worker/'+n for n in WORKER_FILES}:raise ValueError('Unexpected worker content')
    if manifest is not None:
        Path(manifest).write_text(json.dumps([{'path':n,'size':f.stat().st_size,'sha256':sha(f.read_bytes())} for n,f in sorted(files.items())],indent=2),encoding='utf-8')
    with zipfile.ZipFile(package) as z:
        names=archive(z)
        for relative,f in files.items():
            if sha(z.read('lib/app/'+relative))!=sha(f.read_bytes()):raise ValueError('Payload hash mismatch: '+relative)
        extras={n[8:] for n in names if n.startswith('lib/app/') and not n.endswith('/')} - files.keys()
        if extras-{'sq.version','Codex Light_ExecutionStub.exe','Squirrel.exe'}:raise ValueError('Unknown packaged payload: '+str(extras))
        root=ET.fromstring(z.read('lib/app/sq.version'))
        metadata={e.tag.rsplit('}',1)[-1]:e.text for e in root.iter()}
        if metadata.get('id')!=ID or metadata.get('version')!=version or metadata.get('mainExe')!='CodexLight.exe':raise ValueError('Package identity mismatch')
    with zipfile.ZipFile(portable) as z:
        names=archive(z)
        if not {'.portable','Update.exe'}<=names:raise ValueError('Missing portable identity/updater')
        for relative,f in files.items():
            if sha(z.read('current/'+relative))!=sha(f.read_bytes()):raise ValueError('Portable mismatch: '+relative)
    exe=setup.read_bytes()
    if exe[:2]!=b'MZ' or exe.find(data)<0:raise ValueError('Setup does not contain exact verified package')
    result={'version':version,'packageId':ID,'fullOnly':True,'workerPresent':True,'workerVersion':version,'fileCount':len(files),'allPayloadHashesMatch':True,'portableMatches':True,'setupEmbedsExactPackage':True,'artifacts':[]}
    for f in (package,portable,setup,release/'releases.win.json'):
        b=f.read_bytes();result['artifacts'].append({'name':f.name,'size':len(b),'sha256':sha(b)})
    return result
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('release');p.add_argument('payload');p.add_argument('version');p.add_argument('--manifest');a=p.parse_args()
    print(json.dumps(verify(a.release,a.payload,a.version,a.manifest),indent=2))
