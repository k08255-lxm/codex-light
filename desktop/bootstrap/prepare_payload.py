#!/usr/bin/env python3
"""Create hash manifest for an already curated program-only release directory."""
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve();output=pathlib.Path(sys.argv[2])
for required in ['CodexLight.exe','CodexLight.runtimeconfig.json','app/src/desktop-backend.mjs','app/public/index.html']:
 if not (root/required).is_file():raise SystemExit('Incomplete software stage: '+required)
rows=[]
for p in sorted(root.rglob('*')):
 if p.is_symlink():raise SystemExit('Symlink rejected')
 if not p.is_file():continue
 rel=p.relative_to(root)
 if any(x.startswith('.') for x in rel.parts) or any(c in str(rel) for c in ('\n','\r',':')):raise SystemExit('Unsafe payload path: '+str(rel))
 if p.name in ['Install.ps1','Install.cmd','Uninstall.exe','Uninstall.exe.config'] or any(x in ['project-source','node_modules','.git','bootstrap','installer'] for x in rel.parts):raise SystemExit('Not a curated application-only stage: '+str(rel))
 rows.append({'path':rel.as_posix(),'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
output.write_text(json.dumps({'files':rows},ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print('Manifest:',len(rows),'files')
