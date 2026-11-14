// Build-only bundling. No DSH installation, account access or model execution.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {bundleFiles,hashBytes,ordered,sourceDigest,verifyDshBundle,DSH_BUNDLE_FORMAT} from '../../src/dsh-bundle-integrity.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
export const BUNDLE_SOURCE_SCOPES=['src','assets','licenses','LICENSE','README.md','THIRD-PARTY-NOTICES.md','package.json','package-lock.json','manifest.json','build.mjs','bundle.mjs','tools/package.json','tools/package-lock.json'];
function collectSources(){const out={};for(const scope of BUNDLE_SOURCE_SCOPES){const p=path.join(root,scope);if(fs.lstatSync(p).isSymbolicLink())throw Error('Source link refused');if(fs.statSync(p).isDirectory())for(const [name,hash] of Object.entries(bundleFiles(p)))out[scope+'/'+name]=hash;else out[scope]=hashBytes(fs.readFileSync(p));}return ordered(out);}
export async function bundleBridge(){
 const esbuild=await import('./tools/node_modules/esbuild/lib/main.js');if(esbuild.version!=='0.25.12')throw Error('Unexpected esbuild version');
 const toolLock=JSON.parse(fs.readFileSync(path.join(root,'tools/package-lock.json')));if(toolLock.packages?.['node_modules/esbuild']?.version!==esbuild.version)throw Error('Bundler lock mismatch');
 for(const row of Object.values(toolLock.packages).filter(row=>row.resolved)){const url=new URL(row.resolved);if(url.hostname!=='registry.npmjs.org'||url.username||url.password||url.search)throw Error('Bundler must use locked public registry');}
 const out=path.join(root,'dist'),stage=fs.mkdtempSync(path.join(root,'.bundle-stage-'));
 try{
  for(const name of ['assets','licenses','LICENSE','README.md','THIRD-PARTY-NOTICES.md','package.json','package-lock.json'])fs.cpSync(path.join(root,name),path.join(stage,name),{recursive:true});
  fs.mkdirSync(path.join(stage,'src'));
  for(const name of fs.readdirSync(path.join(root,'src')))if(!name.endsWith('.mjs'))fs.cpSync(path.join(root,'src',name),path.join(stage,'src',name));
  const result=await esbuild.build({absWorkingDir:root,entryPoints:fs.readdirSync(path.join(root,'src')).filter(x=>x.endsWith('.mjs')).map(x=>'src/'+x),outdir:path.join(stage,'src'),outExtension:{'.js':'.mjs'},bundle:true,splitting:true,minify:false,format:'esm',platform:'node',target:'node22',metafile:true,legalComments:'eof',banner:{js:"import {createRequire as __bundleCreateRequire} from 'node:module'; const require = __bundleCreateRequire(import.meta.url);"},external:['bufferutil','utf-8-validate','yaml'],plugins:[{name:'preserve-local-source-boundaries',setup(build){build.onResolve({filter:/^\./},a=>a.importer&&path.dirname(a.importer)===path.join(root,'src')?{path:a.path,external:true}:undefined);}}]});
  // ws optional native accelerators remain optional; the tested JS fallback is
  // used. YAML stays a genuine package for runtime createRequire resolution.
  fs.mkdirSync(path.join(stage,'node_modules'));
  fs.cpSync(path.join(root,'node_modules/yaml'),path.join(stage,'node_modules/yaml'),{recursive:true,filter:p=>! /\.d\.(?:ts|mts|cts)(?:\.map)?$/.test(p)});
  const adapter=JSON.parse(fs.readFileSync(path.join(root,'src/provider-sources-adapter.json')));
  for(const name of Object.keys(adapter.files))adapter.files[name]=hashBytes(fs.readFileSync(path.join(stage,'src',name)));
  fs.writeFileSync(path.join(stage,'src/provider-sources-adapter.json'),JSON.stringify(adapter,null,2)+'\n');
  fs.mkdirSync(path.join(stage,'build-provenance'));
  fs.copyFileSync(path.join(root,'tools/package-lock.json'),path.join(stage,'build-provenance/tool-package-lock.json'));
  // Only input path/hash metadata is shipped, not host paths or a stale generated
  // esbuild metafile. The complete output file manifest covers all shared chunks.
  const sourceFiles=collectSources(),base=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
  const manifest={...base,format:DSH_BUNDLE_FORMAT,builder:{name:'esbuild',version:esbuild.version,lockSha256:hashBytes(fs.readFileSync(path.join(root,'tools/package-lock.json')))},sourceFiles,sourceSha256:sourceDigest(sourceFiles),files:bundleFiles(stage)};
  fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');verifyDshBundle(stage);
  // Refuse to overwrite an unknown or modified directory. Only verified generated
  // bundles at this exact output path may be replaced; never installed copies.
  if(fs.existsSync(out)){verifyDshBundle(out);fs.rmSync(out,{recursive:true});}
  fs.renameSync(stage,out);verifyDshBundle(out);
  const bytes=Object.keys(manifest.files).reduce((n,name)=>n+fs.statSync(path.join(out,name)).size,fs.statSync(path.join(out,'manifest.json')).size);
  return {output:out,files:Object.keys(manifest.files).length+1,bytes,modules:Object.keys(result.metafile.inputs).length,sourceSha256:manifest.sourceSha256};
 }finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true});}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await bundleBridge()));
