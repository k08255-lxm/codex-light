// Verify already-installed locked dependencies and collect their exact redistribution notices.
// Dependency installation is an explicit build step, never an application-startup action.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('.',import.meta.url)),hash=value=>createHash('sha256').update(value).digest('hex');
const lockBytes=fs.readFileSync(path.join(root,'package-lock.json')),lock=JSON.parse(lockBytes),inventory=[];
const licenseDir=path.join(root,'licenses');fs.mkdirSync(licenseDir,{recursive:true});
for(const [relative,record] of Object.entries(lock.packages)){
 if(!relative)continue;
 if(!relative.startsWith('node_modules/')||relative.includes('..'))throw Error('Unexpected dependency path');
 const url=new URL(record.resolved);if(url.hostname!=='registry.npmjs.org'||url.username||url.password||url.search)throw Error('Dependency lock must use public, credential-free registry URLs');
 const dir=path.join(root,relative),pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
 if(pkg.version!==record.version)throw Error('Dependency version mismatch: '+relative);
 const files=fs.readdirSync(dir).filter(name=>/^licen[cs]e(?:[.-]|$)/i.test(name)&&fs.statSync(path.join(dir,name)).isFile());
 if(!files.length)throw Error('Dependency license missing: '+pkg.name);
 const notices=[];for(const name of files){const bytes=fs.readFileSync(path.join(dir,name));if(!bytes.length)throw Error('Empty dependency license');const target=pkg.name.replace(/[^a-zA-Z0-9.-]/g,'_')+'-'+pkg.version+'-'+hash(relative).slice(0,8)+'-'+name;fs.writeFileSync(path.join(licenseDir,target),bytes);notices.push('licenses/'+target);}
 inventory.push({name:pkg.name,version:pkg.version,license:pkg.license,notices});
}
inventory.sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
fs.writeFileSync(path.join(licenseDir,'manifest.json'),JSON.stringify(inventory,null,2)+'\n');
const adapterFiles=['config.mjs','manager.mjs','server.mjs','provider-sources.mjs'];
fs.writeFileSync(path.join(root,'src','provider-sources-adapter.json'),JSON.stringify({version:1,bridgeVersion:'0.8.0',files:Object.fromEntries(adapterFiles.map(name=>[name,hash(fs.readFileSync(path.join(root,'src',name)))]))},null,2)+'\n');
for(const name of ['LICENSE','assets/DeepSeek-MIT-LICENSE','src/light-entry.mjs','src/probe-desktop.cjs'])if(!fs.statSync(path.join(root,name)).isFile())throw Error('Missing component payload: '+name);
const manifest={component:'codex-light-dsh-bridge',version:'0.8.0-light.1',entry:'src/light-entry.mjs',dshRuntime:'0.2.2',nodeRuntime:'DSH bundled Node 22.15+ with SQLite',dependencyCount:inventory.length,lockSha256:hash(lockBytes),licenses:'licenses/manifest.json'};
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const notice='# Third-party notices\n\nThis component derives from dsh-subagent-mcp 0.8.0 (MIT, DSH Subagent MCP contributors); see LICENSE. The desktop preset overlay derives from DeepSeek DSH (MIT); see assets/DeepSeek-MIT-LICENSE. DSH itself is not distributed.\n\nAll dependency copyright and license notices are preserved under licenses/. Exact versions and notice paths are in licenses/manifest.json.\n\n'+inventory.map(row=>`- ${row.name} ${row.version}: ${row.license}`).join('\n')+'\n';
fs.writeFileSync(path.join(root,'THIRD-PARTY-NOTICES.md'),notice);
console.log(JSON.stringify({component:manifest.component,version:manifest.version,dependencies:inventory.length,licensesPreserved:true}));
