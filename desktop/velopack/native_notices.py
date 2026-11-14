"""Verify the pinned, evidence-backed native notice subset; not an exhaustive SBOM."""
import argparse,hashlib,json,shutil
from pathlib import Path,PurePosixPath
from stage import plain
NAME='velopack-native-1.3.39-g8d2844f'
ROOT=Path(__file__).resolve().parents[2]/'licenses'/NAME

def validate(root,vendor=None):
 root=Path(root);plain(root)
 manifest=json.loads((root/'files.sha256.json').read_text(encoding='utf-8'))
 if len(manifest)!=194:raise ValueError('Native notice inventory changed; refresh the pinned audit')
 seen=set()
 for item in manifest:
  name=item['path'];rel=PurePosixPath(name)
  if rel.is_absolute() or '..' in rel.parts or '\\' in name or ':' in name or name.casefold() in seen:raise ValueError('Unsafe/duplicate native notice path')
  seen.add(name.casefold());f=root/name;plain(f)
  if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest()!=item['sha256']:raise ValueError('Missing/changed native notice: '+name)
 if vendor:
  for item in json.loads((root/'binary-evidence.json').read_text()):
   p=Path(vendor)/item['binary'];plain(p)
   if hashlib.sha256(p.read_bytes()).hexdigest()!=item['sha256']:raise ValueError('Pinned native binary changed: '+item['binary'])
 return len(manifest)

def stage_notices(payload,vendor):
 validate(ROOT,vendor)
 destination=Path(payload)/'licenses'/NAME
 if destination.exists():
  validate(destination)
  # Never overwrite an unexpected tree; packaging output must be newly owned.
  if {p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()}!={p.relative_to(ROOT).as_posix() for p in ROOT.rglob('*') if p.is_file()}:raise ValueError('Unexpected staged notice files')
 else:shutil.copytree(ROOT,destination)
 validate(destination)

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--payload');p.add_argument('--vendor');a=p.parse_args()
 if a.payload:
  if not a.vendor:p.error('--payload requires --vendor')
  stage_notices(a.payload,a.vendor)
 else:validate(ROOT,a.vendor)
 print('Pinned native supplemental notices verified (not exhaustive SBOM)')
