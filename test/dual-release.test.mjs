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
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'dual-release-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const msiDirectory=path.join(root,'msi'),velopackDirectory=path.join(root,'velo');
 for(const p of [msiDirectory,velopackDirectory])await mkdir(p);
 const entries=[[msiDirectory,`CodexLight-Setup-${version}-x64.exe`],[velopackDirectory,`CodexLightDesktop-${version}-full.nupkg`],[velopackDirectory,`CodexLight-NewInstall-${version}-x64.zip`],[velopackDirectory,'releases.win.json']];
 for(const [dir,name] of entries)await writeFile(path.join(dir,name),`fixture ${name}`);
 for(const dir of [msiDirectory,velopackDirectory])await writeFile(path.join(dir,'SHA256SUMS.txt'),(await Promise.all(entries.filter(e=>e[0]===dir).map(async([,name])=>`${hash(await readFile(path.join(dir,name)))}  ${name}`))).join('\n'));
 const name=entries[1][1],bytes=await readFile(path.join(velopackDirectory,name));
 await writeFile(path.join(velopackDirectory,'verification.json'),JSON.stringify({version,packageId:'CodexLightDesktop',fullOnly:true,workerPresent:true,allPayloadHashesMatch:true,portableMatches:true,setupEmbedsExactPackage:true,artifacts:[{name,size:bytes.length,sha256:hash(bytes)}]}));
 const apk=path.join(root,`codex-light-${version}.apk`);await writeFile(apk,'PK fake signing tested separately');
 return {version,msiDirectory,velopackDirectory,apk,output:path.join(root,'release')};
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
 await rm(path.join(f.velopackDirectory,'MIGRATION-STAGE-ONLY.txt'));await rm(path.join(f.msiDirectory,'CodexLight-Setup-0.4.4-x64.exe'));
 await assert.rejects(assembleRelease(f),{code:'ENOENT'});
});
test('released 0.4.3 desktop checker accepts the combined metadata',async t=>{
 let source;try{source=execFileSync('git',['show','v0.4.3:src/app-update.mjs'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch{t.skip('Release tag unavailable in this checkout');return;}
 source=source.replace("'./update-manifest.mjs'",JSON.stringify(new URL('../src/update-manifest.mjs',import.meta.url).href));
 const old=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const f=await fixture(t),release=await assembleRelease(f),selected=old.parseAppRelease(release,'0.4.3');
 assert.equal(selected.available,true);assert.equal(selected.setup.name,'CodexLight-Setup-0.4.4-x64.exe');
 assert.equal(old.publishedSetupHash(await readFile(path.join(f.output,'SHA256SUMS.txt'),'utf8'),selected.setup.name),hash(await readFile(path.join(f.output,selected.setup.name))));
});
