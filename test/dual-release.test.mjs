import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assembleRelease} from '../scripts/assemble-release.mjs';
import {parseAppRelease} from '../src/app-update.mjs';
import {execFileSync} from 'node:child_process';
const version='0.4.4',hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,version='0.4.4'){
 const root=await mkdtemp(path.join(os.tmpdir(),'dual-release-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const msiDirectory=path.join(root,'msi'),velopackDirectory=path.join(root,'velo');
 for(const p of [msiDirectory,velopackDirectory])await mkdir(p);
 const entries=[[msiDirectory,`CodexLight-Setup-${version}-x64.exe`],[velopackDirectory,`CodexLightDesktop-${version}-full.nupkg`],[velopackDirectory,`CodexLight-NewInstall-${version}-x64.zip`],[velopackDirectory,'releases.win.json']];
 for(const [dir,name] of entries)await writeFile(path.join(dir,name),`fixture ${name}`);
 for(const dir of [msiDirectory,velopackDirectory])await writeFile(path.join(dir,'SHA256SUMS.txt'),(await Promise.all(entries.filter(e=>e[0]===dir).map(async([,name])=>`${hash(await readFile(path.join(dir,name)))}  ${name}`))).join('\n'));
 const name=entries[1][1],bytes=await readFile(path.join(velopackDirectory,name));
 await writeFile(path.join(velopackDirectory,'verification.json'),JSON.stringify({version,packageId:'CodexLightDesktop',fullOnly:true,workerPresent:true,allPayloadHashesMatch:true,portableMatches:true,setupEmbedsExactPackage:true,artifacts:[{name,size:bytes.length,sha256:hash(bytes)}]}));
 const apk=path.join(root,`codex-light-${version}.apk`);await writeFile(apk,'PK fake signing tested separately');
 const bootstrapName=entries[0][1];
 await writeFile(path.join(msiDirectory,'release-bootstrap-receipt.json'),JSON.stringify({schema:1,version,migrationSupported:true,bootstrapName,bootstrapSha256:hash(await readFile(path.join(msiDirectory,bootstrapName))),migrationBundleSha256:'a'.repeat(64),vendorSetupSha256:'b'.repeat(64),migrationManifestSha256:'c'.repeat(64)}));
 return {version,setupDirectory:msiDirectory,velopackDirectory,apk,output:path.join(root,'release')};
}
test('one release routes MSI and Velopack separately, keeping versioned APK and no bare vendor Setup',async t=>{
 const f=await fixture(t),r=await assembleRelease(f);
 assert.equal(parseAppRelease(r,'0.4.3','msi').setup.name,'CodexLight-Setup-0.4.4-x64.exe');
 assert.equal(parseAppRelease(r,'0.4.3','velopack').setup.name,'CodexLightDesktop-0.4.4-full.nupkg');
 const names=await readdir(f.output);assert.equal(names.length,6);assert.ok(names.includes('codex-light-0.4.4.apk'));assert.ok(!names.includes('CodexLightDesktop-win-Setup.exe'));
 await assert.rejects(assembleRelease(f),{code:'EEXIST'});
});
test('reject stale verified package, before creating output',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.velopackDirectory,'CodexLightDesktop-0.4.4-full.nupkg'),'tampered');
 await assert.rejects(assembleRelease(f),/checksum/);await assert.rejects(readdir(f.output),{code:'ENOENT'});
});
test('never publish migration-stage or incomplete single-transport outputs',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.velopackDirectory,'MIGRATION-STAGE-ONLY.txt'),'stage');
 await assert.rejects(assembleRelease(f),/staging/);
 await rm(path.join(f.velopackDirectory,'MIGRATION-STAGE-ONLY.txt'));await rm(path.join(f.setupDirectory,'CodexLight-Setup-0.4.4-x64.exe'));
 await assert.rejects(assembleRelease(f),{code:'ENOENT'});
});
test('reject legacy MSI-only setup receipts',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.setupDirectory,'release-bootstrap-receipt.json'),JSON.stringify({version,migrationSupported:false}));
 await assert.rejects(assembleRelease(f),/migration-aware/);
});
test('released 0.4.3 desktop checker accepts the combined metadata',async t=>{
 let source;try{source=execFileSync('git',['show','v0.4.3:src/app-update.mjs'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch{t.skip('Release tag unavailable in this checkout');return;}
 source=source.replace("'./update-manifest.mjs'",JSON.stringify(new URL('../src/update-manifest.mjs',import.meta.url).href));
 const old=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const f=await fixture(t),release=await assembleRelease(f),selected=old.parseAppRelease(release,'0.4.3');
 assert.equal(selected.available,true);assert.equal(selected.setup.name,'CodexLight-Setup-0.4.4-x64.exe');
 assert.equal(old.publishedSetupHash(await readFile(path.join(f.output,'SHA256SUMS.txt'),'utf8'),selected.setup.name),hash(await readFile(path.join(f.output,selected.setup.name))));
 // A historical bridge alone cannot service an old client that skips to a later latest release.
 const skipped={...release,tag_name:'v0.9.0',html_url:'https://github.com/k08255-lxm/codex-light/releases/tag/v0.9.0',assets:release.assets.map(a=>({...a,browser_download_url:a.browser_download_url.replace('/v0.4.4/','/v0.9.0/')}))};
 assert.throws(()=>old.parseAppRelease(skipped,'0.4.3'));
 const routed={...skipped,assets:skipped.assets.map(a=>a.name==='CodexLight-Setup-0.4.4-x64.exe'?{...a,name:'CodexLight-Setup-0.9.0-x64.exe',browser_download_url:a.browser_download_url.replace('Setup-0.4.4','Setup-0.9.0')}:a)};
 assert.equal(old.parseAppRelease(routed,'0.4.3').setup.name,'CodexLight-Setup-0.9.0-x64.exe');
});

async function routerFixture(t){
 const f=await fixture(t,'0.4.5'),p=path.join(f.setupDirectory,'release-bootstrap-receipt.json');
 const receipt=JSON.parse(await readFile(p,'utf8'));
 Object.assign(receipt,{schema:2,mode:'fixedBridgeThenPrompt',bridgeVersion:'0.4.4',bridgeUrl:'https://github.com/k08255-lxm/codex-light/releases/download/v0.4.4/CodexLight-Setup-0.4.4-x64.exe',bridgeSha256:'b2410266d12946301ffecebaa9c1fa77c8cebd065fe889cdb8eb83b974245aba',freshName:'CodexLight-NewInstall-0.4.5-x64.zip',freshSha256:hash(await readFile(path.join(f.velopackDirectory,'CodexLight-NewInstall-0.4.5-x64.zip')))});
 await writeFile(p,JSON.stringify(receipt));return {f,p,receipt};
}
test('fixed bridge router receipt binds current fresh archive and preserves both transports',async t=>{
 const {f}=await routerFixture(t),release=await assembleRelease(f);
 assert.equal(parseAppRelease(release,'0.4.3','msi').setup.name,'CodexLight-Setup-0.4.5-x64.exe');
 assert.equal(parseAppRelease(release,'0.4.4','velopack').setup.name,'CodexLightDesktop-0.4.5-full.nupkg');
});
for(const field of ['bridgeVersion','bridgeUrl','bridgeSha256','mode','freshName','freshSha256'])test('router receipt rejects changed '+field,async t=>{
 const {f,p,receipt}=await routerFixture(t);receipt[field]='changed';await writeFile(p,JSON.stringify(receipt));await assert.rejects(assembleRelease(f),/migration-aware/);await assert.rejects(readdir(f.output),{code:'ENOENT'});
});

test('released 0.4.4 detects target full package and startup check notifies without installing',async t=>{
 const source=execFileSync('git',['show','v0.4.4:src/app-update.mjs'],{encoding:'utf8'}).replace("'./update-manifest.mjs'",JSON.stringify(new URL('../src/update-manifest.mjs',import.meta.url).href));
 const old=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const {f}=await routerFixture(t),release=await assembleRelease(f),selected=old.parseAppRelease(release,'0.4.4','velopack');
 assert.equal(selected.available,true);assert.equal(selected.version,'0.4.5');assert.equal(selected.setup.name,'CodexLightDesktop-0.4.5-full.nupkg');
 const auto=execFileSync('git',['show','v0.4.4:public/ui/auto-update.js'],{encoding:'utf8'});
 const {startUpdateChecks}=await import('data:text/javascript;base64,'+Buffer.from(auto).toString('base64'));
 let callback,delay,calls=0;const notices=[];
 const stop=startUpdateChecks({check:async()=>{calls++;return {latest:{available:true,version:'0.4.5'}}},notify:v=>notices.push(v),setTimer:(fn,ms)=>{callback=fn;delay=ms;return 1},clearTimer:()=>{}});
 assert.equal(delay,3000);assert.equal(calls,0);await callback();assert.equal(calls,1);assert.deepEqual(notices,['0.4.5']);assert.equal(delay,6*60*60*1000);await callback();assert.deepEqual(notices,['0.4.5']);stop();
});

test('post-bridge releases reject embedded schema1 migration even when hashes are valid',async t=>{
 const f=await fixture(t,'0.4.5');await assert.rejects(assembleRelease(f),/migration-aware/);await assert.rejects(readdir(f.output),{code:'ENOENT'});
});

test('embedded fresh payload publishes one EXE and preserves old transports with same-version APK',async t=>{
 const {f,p,receipt}=await routerFixture(t);Object.assign(receipt,{schema:3,freshEmbedded:true,embeddedResource:'CodeCang.Fresh.zip'});await writeFile(p,JSON.stringify(receipt));
 const release=await assembleRelease(f);
 const names=release.assets.map(a=>a.name);assert.equal(names.length,5);assert.equal(names.filter(n=>n.endsWith('.exe')).length,1);assert.ok(!names.some(n=>n.endsWith('.zip')));assert.ok(names.includes('codex-light-0.4.5.apk'));
 for(const [tag,transport] of [['v0.4.3','msi'],['v0.4.4','velopack'],['3556bd4b755f5177e131798990a5235ce1d450c4','velopack']]){
  const source=execFileSync('git',['show',`${tag}:src/app-update.mjs`],{encoding:'utf8'}).replace("'./update-manifest.mjs'",JSON.stringify(new URL('../src/update-manifest.mjs',import.meta.url).href));
  const old=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const selected=old.parseAppRelease(release,'0.4.3',transport);assert.ok(names.includes(selected.setup.name));assert.ok(old.publishedSetupHash(await readFile(path.join(f.output,'SHA256SUMS.txt'),'utf8'),selected.setup.name));
 }
});
test('embedded receipt must identify validated resource',async t=>{const {f,p,receipt}=await routerFixture(t);receipt.schema=3;await writeFile(p,JSON.stringify(receipt));await assert.rejects(assembleRelease(f),/embedded fresh/);});

// Mirrors the shipped 0.4.3-0.4.6 checker asset predicate, not a new-client flag.
function legacyAndroidHasUpdate(release,current){
 const candidate=release.tag_name.replace(/^v/,'');
 const newer=candidate.split('.').reduce((result,n,i)=>result||Math.sign(Number(n)-Number(current.split('.')[i])),0)>0;
 return !release.draft&&!release.prerelease&&newer&&release.assets.some(a=>a.name===`codex-light-${candidate}.apk`&&a.browser_download_url===`https://github.com/k08255-lxm/codex-light/releases/download/${release.tag_name}/codex-light-${candidate}.apk`);
}
test('unchanged Android remains downloadable without notifying old APKs; desktop routes survive',async t=>{
 const f=await fixture(t),release=await assembleRelease({...f,androidNotify:false});
 assert.equal(legacyAndroidHasUpdate(release,'0.4.3'),false);
 const apk=release.assets.find(a=>a.name.endsWith('.apk'));
 assert.equal(apk.name,'codex-light-android-0.4.4.apk');
 assert.deepEqual(await readFile(path.join(f.output,apk.name)),await readFile(f.apk));
 assert.match(await readFile(path.join(f.output,'SHA256SUMS.txt'),'utf8'),/codex-light-android-0.4.4.apk/);
 for(const mode of ['msi','velopack'])assert.equal(parseAppRelease(release,'0.4.3',mode).available,true);
});
test('normal Android release still notifies old clients and same-version does not',async t=>{
 const release=await assembleRelease(await fixture(t));
 assert.equal(legacyAndroidHasUpdate(release,'0.4.3'),true);
 assert.equal(legacyAndroidHasUpdate(release,'0.4.4'),false);
});
test('notification flag must be explicitly boolean',async t=>{
 await assert.rejects(assembleRelease({...await fixture(t),androidNotify:'false'}),/boolean/);
});
