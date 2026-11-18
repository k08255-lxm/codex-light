"""Consolidate only notices already selected for this payload. Preserve every byte.

The bridge keeps one self-contained collected text for standalone verification.
This does not resolve missing upstream notices or supply legal clearance.
"""
import hashlib,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'msi'))
from notice_text import collect,read
from bridge_bundle import validate as validate_bridge
from stage import plain
from native_notices import ROOT,NAME,validate as validate_native

PROJECT='LICENSE'
THIRD='THIRD-PARTY-NOTICES.txt'
ORIGINAL_PROJECT='CodexLight-LICENSE.txt'
REQUIRED={'Velopack-LICENSE.txt','Velopack-VENDOR-NOTICES.md','WebView2-LICENSE.txt',
 'WebView2-NOTICE.txt','WindowsNotifications-LICENSE.md','WindowsSDK-NOTICE.txt','DotNet-AppHost-LICENSE.txt','DotNet-AppHost-THIRD-PARTY-NOTICES.txt',
 'THIRD-PARTY-NOTICES.md','VERSIONS.txt','xterm/LICENSE','xterm/addon-fit-LICENSE',
 'dsh-bridge/Bridge-MIT-LICENSE.txt','dsh-bridge/DeepSeek-MIT-LICENSE.txt'}

def bridge_notices(payload):
 root=Path(payload)/'app/components/dsh-bridge'
 validate_bridge(root)
 import json
 manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
 rows=json.loads((root/'licenses/manifest.json').read_text(encoding='utf-8'))
 paths={n for row in rows for n in row['notices']}|{'LICENSE','THIRD-PARTY-NOTICES.md','assets/DeepSeek-MIT-LICENSE'}
 texts=read((root/manifest['noticeText']).read_bytes()) if manifest.get('noticeText') else {n:(root/n).read_bytes() for n in paths}
 result={('dsh-bridge/'+n[len('licenses/'):]):texts[n] for n in paths if n.startswith('licenses/')}
 result.update({'dsh-bridge/Bridge-MIT-LICENSE.txt':texts['LICENSE'],'dsh-bridge/DeepSeek-MIT-LICENSE.txt':texts['assets/DeepSeek-MIT-LICENSE'],'dsh-bridge/THIRD-PARTY-NOTICES.md':texts['THIRD-PARTY-NOTICES.md'],'dsh-bridge/manifest.json':(root/'licenses/manifest.json').read_bytes()})
 return result

def validate(payload):
 payload=Path(payload);plain(payload/PROJECT);plain(payload/THIRD)
 if (payload/'licenses').exists() and any(p.is_file() for p in (payload/'licenses').rglob('*')):
  raise ValueError('Mixed collected and loose notices')
 source=read((payload/THIRD).read_bytes())
 if not REQUIRED<=source.keys():raise ValueError('Required third-party notices missing')
 if (payload/PROJECT).read_bytes()!=(Path(__file__).resolve().parents[2]/'LICENSE').read_bytes():raise ValueError('Project license changed')
 validate_native(ROOT)
 expected={p.relative_to(ROOT).as_posix():p.read_bytes() for p in ROOT.rglob('*') if p.is_file()}
 native={n[len(NAME)+1:]:b for n,b in source.items() if n.startswith(NAME+'/')}
 if native!=expected:raise ValueError('Native notice source inventory/text mismatch')
 if {n:b for n,b in source.items() if n.startswith('dsh-bridge/')}!=bridge_notices(payload):raise ValueError('Distributed bridge notice mismatch')
 return source

def consolidate(payload,*,owned_build_stage=False):
 if not owned_build_stage:raise ValueError('Fresh owned build stage must be explicitly selected; never consolidate an installed copy')
 payload=Path(payload);directory=payload/'licenses';plain(directory)
 if (payload/PROJECT).exists() or (payload/THIRD).exists():raise ValueError('Collected output already exists')
 entries={}
 for p in sorted(directory.rglob('*')):
  plain(p)
  if p.is_file():entries[p.relative_to(directory).as_posix()]=p.read_bytes()
 project=entries.pop(ORIGINAL_PROJECT)
 original=dict(entries)
 selected=bridge_notices(payload)
 # Only esbuild-emitted modules and physically copied runtime packages are selected.
 for n,b in selected.items():
  if n!='dsh-bridge/manifest.json' and entries.get(n)!=b:raise ValueError('Distributed bridge notice differs from staged original')
 entries={n:b for n,b in entries.items() if not n.startswith('dsh-bridge/')};entries.update(selected)
 if not REQUIRED<=entries.keys():raise ValueError('Missing staged legal inputs')
 validate_native(directory/NAME)
 packed=collect(entries)
 if read(packed)!=entries:raise ValueError('Notice byte preservation failed')
 # Save and reread before removing only known files in this owned staging tree.
 with (payload/PROJECT).open('xb') as f:f.write(project)
 with (payload/THIRD).open('xb') as f:f.write(packed)
 if read((payload/THIRD).read_bytes())!=entries or (payload/PROJECT).read_bytes()!=project:raise ValueError('Notice writeback mismatch')
 for n in [ORIGINAL_PROJECT,*original]:
  p=directory/n;plain(p)
  if p.read_bytes()!=(project if n==ORIGINAL_PROJECT else original[n]):raise ValueError('Staged notice changed during consolidation')
 # All source files survive in git; only fresh staged duplicate paths are removed.
 for n in [ORIGINAL_PROJECT,*original]:(directory/n).unlink()
 for p in sorted(directory.rglob('*'),key=lambda p:len(p.parts),reverse=True):
  if p.is_dir():p.rmdir()
 directory.rmdir()
 validate(payload)
 return {'originalFiles':len(original)+1,'collectedFiles':2,
  'originalBytes':len(project)+sum(map(len,original.values())),
  'collectedBytes':len(project)+len(packed),'sourceEntries':len(entries),'excludedUnshippedBridgeNotices':len(original)-len(entries)}

if __name__=='__main__':
 import argparse,json
 p=argparse.ArgumentParser();p.add_argument('payload');p.add_argument('--owned-build-stage',action='store_true',required=True);a=p.parse_args()
 print(json.dumps(consolidate(a.payload,owned_build_stage=a.owned_build_stage)))
