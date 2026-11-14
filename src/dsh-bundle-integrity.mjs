// Integrity checking is not code execution or a signature. It detects stale,
// incomplete and corrupted bundle layouts; release signing remains separate.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const DSH_BUNDLE_FORMAT='codex-light-dsh-bundle-v1';
export const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
export const ordered=value=>Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0));
export const sourceDigest=files=>hashBytes(JSON.stringify(ordered(files)));
const hex=/^[a-f0-9]{64}$/;
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
export function safeBundlePath(name){return typeof name==='string'&&name.length<1024&&!name.includes('\\')&&!name.includes(':')&&!/[\x00-\x1f]/.test(name)&&!name.startsWith('/')&&name.split('/').every(p=>p&&p!=='.'&&p!=='..');}
export function bundleFiles(root){
 const files={};const real=fs.realpathSync(root);if(fs.lstatSync(root).isSymbolicLink())throw Error('Bundle root is a link');
 function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
  const file=path.join(dir,item.name),info=fs.lstatSync(file),rel=path.relative(root,file).split(path.sep).join('/');
  if(!safeBundlePath(rel)||info.isSymbolicLink()||!fs.realpathSync(file).startsWith(real+path.sep))throw Error('Unsafe bundle entry: '+rel);
  if(info.isDirectory())walk(file);else if(info.isFile())files[rel]=hashBytes(fs.readFileSync(file));else throw Error('Nonregular bundle entry: '+rel);
 }}walk(root);return ordered(files);
}
function hashMap(map,label){if(!plain(map)||!Object.keys(map).length||Object.keys(map).length>10000)throw Error('Invalid '+label);const folded=new Set();for(const [name,hash] of Object.entries(map)){if(!safeBundlePath(name)||!hex.test(hash)||folded.has(name.toLowerCase()))throw Error('Invalid '+label+' path/hash');folded.add(name.toLowerCase());}}
export function verifyDshBundle(root){
 const manifestPath=path.join(root,'manifest.json');if(fs.lstatSync(manifestPath).isSymbolicLink()||fs.statSync(manifestPath).size>4*1024*1024)throw Error('Invalid bundle manifest file');
 const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 if(m.format!==DSH_BUNDLE_FORMAT||m.component!=='codex-light-dsh-bridge'||m.entry!=='src/light-entry.mjs'||m.licenses!=='licenses/manifest.json'||m.builder?.name!=='esbuild'||m.builder.version!=='0.25.12')throw Error('Unsupported bridge bundle');
 hashMap(m.files,'output manifest');hashMap(m.sourceFiles,'source manifest');
 if(!hex.test(m.lockSha256)||!hex.test(m.builder.lockSha256)||m.sourceSha256!==sourceDigest(m.sourceFiles)||Object.hasOwn(m.files,'manifest.json'))throw Error('Invalid bundle provenance');
 const actual=bundleFiles(root);delete actual['manifest.json'];
 if(JSON.stringify(ordered(actual))!==JSON.stringify(ordered(m.files)))throw Error('Bundle file set or content mismatch');
 const required=['src/light-entry.mjs','src/service-runner.mjs','src/server.mjs','src/probe-desktop.cjs','src/dsh-plugin.mjs','src/config.mjs','src/manager.mjs','src/provider-sources.mjs','src/provider-sources-adapter.json','package.json','package-lock.json','LICENSE','THIRD-PARTY-NOTICES.md','assets/DeepSeek-MIT-LICENSE','licenses/manifest.json','node_modules/yaml/package.json','node_modules/yaml/dist/index.js','build-provenance/tool-package-lock.json'];
 if(required.some(name=>!Object.hasOwn(actual,name)))throw Error('Missing required bundle runtime file');
 if(actual['package-lock.json']!==m.lockSha256||actual['build-provenance/tool-package-lock.json']!==m.builder.lockSha256)throw Error('Bundle lock mismatch');
 const json=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
 const adapter=json('src/provider-sources-adapter.json');if(adapter.version!==1||['config.mjs','manager.mjs','server.mjs','provider-sources.mjs'].some(name=>adapter.files?.[name]!==actual['src/'+name]))throw Error('Bundle adapter hash mismatch');
 const lock=json('package-lock.json'),licenses=json('licenses/manifest.json');
 const packages=Object.entries(lock.packages||{}).filter(([name])=>name);
 if(m.dependencyCount!==packages.length||!Array.isArray(licenses)||licenses.length!==packages.length)throw Error('Bundle license inventory incomplete');
 for(const [relative,record] of packages){const name=relative.slice(relative.lastIndexOf('node_modules/')+13);const rows=licenses.filter(row=>row.name===name&&row.version===record.version);if(!rows.length||rows.some(row=>!Array.isArray(row.notices)||!row.notices.length||row.notices.some(notice=>!notice.startsWith('licenses/')||!Object.hasOwn(actual,notice)||fs.statSync(path.join(root,notice)).size===0)))throw Error('Bundle license missing: '+name);}
 return m;
}
