#!/usr/bin/env python3
"""Generate exact file lists; uninstall never recursively removes a directory."""
import pathlib, sys
root=pathlib.Path(sys.argv[1]).resolve()
out=pathlib.Path(__file__).parent
required=['CodexLight.exe','CodexLight.runtimeconfig.json','app/src/desktop-backend.mjs','app/public/index.html']
for name in required:
    if not (root/name).is_file(): raise SystemExit('Incomplete payload: '+name)
files=[]
for p in sorted(root.rglob('*')):
    if p.is_symlink(): raise SystemExit('Symlink payload rejected: '+str(p))
    if not p.is_file(): continue
    rel=p.relative_to(root)
    if any(part.startswith('.') for part in rel.parts): raise SystemExit('Hidden payload rejected: '+str(rel))
    if p.name in ('Install.ps1','Install.cmd'): continue
    if any(c in str(rel) for c in ('\n', '\r', '$', '"')): raise SystemExit('Unsupported payload name')
    files.append(str(rel).replace('/','\\'))
install=['; Generated exact owned payload; do not edit.']
for f in files:
    parent=f.rsplit('\\',1)[0] if '\\' in f else ''
    install += ['SetOutPath "$INSTDIR'+('\\'+parent if parent else '')+'"', 'File "${PAYLOAD}\\'+f+'"']
uninstall=['; Delete only exact packaged files; retain all unknown user additions.']
uninstall += ['Delete "$INSTDIR\\'+f+'"' for f in files]
dirs=set()
for f in files:
    while '\\' in f:
        f=f.rsplit('\\',1)[0];dirs.add(f)
uninstall += ['RMDir "$INSTDIR\\'+d+'"' for d in sorted(dirs,key=lambda s:(s.count('\\'),s),reverse=True)]
(out/'payload-install.nsh').write_text('\n'.join(install)+'\n',encoding='utf-8')
(out/'payload-uninstall.nsh').write_text('\n'.join(uninstall)+'\n',encoding='utf-8')
print('Prepared',len(files),'owned files; no recursive uninstall')
