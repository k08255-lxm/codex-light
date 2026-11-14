import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {collectNoticeText,readNoticeText} from '../src/notice-text.mjs';
import {verifyDshBundle,hashBytes} from '../src/dsh-bundle-integrity.mjs';
const source=new URL('../components/dsh-bridge/dist/',import.meta.url);
test('real compact bridge preserves every source notice and both validators reject omissions/rewrites',{skip:!fs.existsSync(new URL('manifest.json',source))},t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'collected-notice-check-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));fs.cpSync(source,temp,{recursive:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(temp,'manifest.json'))),name=manifest.noticeText;
 assert.equal(name,'THIRD-PARTY-NOTICES.txt');verifyDshBundle(temp);
 const original=readNoticeText(fs.readFileSync(path.join(temp,name))),notice=Object.keys(original).find(n=>n.startsWith('licenses/'));
 assert.ok(notice);assert.ok(original.LICENSE);assert.ok(original['assets/DeepSeek-MIT-LICENSE']);
 for(const action of ['omit','rewrite']){
  const entries={...original};if(action==='omit')delete entries[notice];else entries[notice]=Buffer.from('MIT, but copyright omitted');
  const bytes=collectNoticeText(entries);fs.writeFileSync(path.join(temp,name),bytes);manifest.files[name]=hashBytes(bytes);fs.writeFileSync(path.join(temp,'manifest.json'),JSON.stringify(manifest));
  assert.throws(()=>verifyDshBundle(temp),/Notice source inventory mismatch/);
  const python=spawnSync('python',['desktop/msi/bridge_bundle.py',temp],{encoding:'utf8'});assert.notEqual(python.status,0);assert.match(python.stderr,/Notice source inventory mismatch/);
 }
});
