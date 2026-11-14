// Assemble already verified build outputs. Does not publish, install or migrate.
import {readFile,writeFile,mkdir,lstat,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseAppRelease,publishedSetupHash} from '../src/app-update.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const json=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
async function plain(file){
 for(let p=path.resolve(file);;p=path.dirname(p)){
  const info=await lstat(p);if(info.isSymbolicLink())throw Error('Linked input refused: '+file);
  if(path.dirname(p)===p)break;
 }
}
async function checked(directory,name){
 const file=path.join(directory,name);await plain(file);
 if(!(await lstat(file)).isFile())throw Error('Expected file: '+name);
 const bytes=await readFile(file),digest=hash(bytes);
 const lines=(await readFile(path.join(directory,'SHA256SUMS.txt'),'utf8')).replace(/^\uFEFF/,'').split(/\r?\n/);
 const matches=lines.map(s=>/^([a-f\d]{64})\s+\*?(.+)$/i.exec(s)).filter(m=>m?.[2]===name);
 if(matches.length!==1||matches[0][1].toLowerCase()!==digest)throw Error('Missing/stale checksum: '+name);
 return {file,name,size:bytes.length,sha256:digest};
}
export async function assembleRelease({version,setupDirectory,velopackDirectory,apk,output}){
 if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw Error('Invalid release version');
 // Both transports are mandatory: never strand existing installations on a new latest release.
 const setup=`CodexLight-Setup-${version}-x64.exe`,full=`CodexLightDesktop-${version}-full.nupkg`;
 const fresh=`CodexLight-NewInstall-${version}-x64.zip`,apkName=`codex-light-${version}.apk`;
 const verification=await json(path.join(velopackDirectory,'verification.json'));
 if(verification.version!==version||verification.packageId!=='CodexLightDesktop'||
   !['fullOnly','workerPresent','allPayloadHashesMatch','portableMatches','setupEmbedsExactPackage'].every(k=>verification[k]===true))throw Error('Velopack verification incomplete');
 for(const marker of ['MIGRATION-STAGE-ONLY.txt','migration-release.json']){
  try{await lstat(path.join(velopackDirectory,marker));throw Error('Migration staging output cannot be released');}
  catch(e){if(e.code!=='ENOENT')throw e;}
 }
 const files=await Promise.all([checked(setupDirectory,setup),checked(velopackDirectory,full),checked(velopackDirectory,fresh),checked(velopackDirectory,'releases.win.json')]);
 const bootstrap=await json(path.join(setupDirectory,'release-bootstrap-receipt.json'));
 const identity=bootstrap.version===version&&bootstrap.migrationSupported===true&&bootstrap.bootstrapName===setup&&bootstrap.bootstrapSha256===files[0].sha256;
 const postBridge=version.split('.').map(Number).reduce((r,n,i)=>r||Math.sign(n-[0,4,4][i]),0)>0;
 const legacy=!postBridge&&bootstrap.schema===1&&['migrationBundleSha256','vendorSetupSha256','migrationManifestSha256'].every(k=>/^[a-f\d]{64}$/.test(bootstrap[k]??''));

 const router=postBridge&&bootstrap.schema===2&&bootstrap.mode==='fixedBridgeThenPrompt'&&bootstrap.bridgeVersion==='0.4.4'&&
  bootstrap.bridgeUrl==='https://github.com/k08255-lxm/codex-light/releases/download/v0.4.4/CodexLight-Setup-0.4.4-x64.exe'&&
  bootstrap.bridgeSha256==='b2410266d12946301ffecebaa9c1fa77c8cebd065fe889cdb8eb83b974245aba'&&
  bootstrap.freshName===fresh&&bootstrap.freshSha256===files[2].sha256;
 if(!identity||(!legacy&&!router))throw Error('Verified migration-aware bootstrap required; legacy MSI Setup is insufficient');
 const recorded=verification.artifacts?.filter(a=>a.name===full);
 if(recorded?.length!==1||recorded[0].sha256!==files[1].sha256||recorded[0].size!==files[1].size)throw Error('Stale package verification');
 await plain(apk);if(path.basename(apk)!==apkName)throw Error('APK must have exact versioned name');
 const apkBytes=await readFile(apk);if(apkBytes[0]!==0x50||apkBytes[1]!==0x4b)throw Error('APK is not an archive');
 // APK signing/version inspection is a separate build gate, not inferred from its filename.
 files.push({file:apk,name:apkName,size:apkBytes.length,sha256:hash(apkBytes)});
 const sums=files.map(f=>`${f.sha256}  ${f.name}`).join('\n')+'\n';
 const base=`https://github.com/k08255-lxm/codex-light/releases/download/v${version}/`;
 const release={tag_name:`v${version}`,draft:false,prerelease:false,html_url:`https://github.com/k08255-lxm/codex-light/releases/tag/v${version}`,assets:[...files,{name:'SHA256SUMS.txt',size:Buffer.byteLength(sums)}].map(f=>({name:f.name,size:f.size,browser_download_url:base+f.name}))};
 for(const transport of ['msi','velopack']){
  const selected=parseAppRelease(release,'0.4.3',transport);
  if(publishedSetupHash(sums,selected.setup.name)!==files.find(f=>f.name===selected.setup.name)?.sha256)throw Error('Update route mismatch');
 }
 await plain(path.dirname(path.resolve(output)));await mkdir(output); // Never overwrite release artifacts.
 for(const f of files){await copyFile(f.file,path.join(output,f.name),1);if(hash(await readFile(path.join(output,f.name)))!==f.sha256)throw Error('Input changed during copy');}
 await writeFile(path.join(output,'SHA256SUMS.txt'),sums,{flag:'wx'});
 return release;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [version,setupDirectory,velopackDirectory,apk,output]=process.argv.slice(2);
 if(!output)throw Error('Usage: node scripts/assemble-release.mjs VERSION BOOTSTRAP_RELEASE_DIR VELOPACK_RELEASE_DIR VERSIONED_APK NEW_OUTPUT');
 console.log(JSON.stringify(await assembleRelease({version,setupDirectory,velopackDirectory,apk,output}),null,2));
}
