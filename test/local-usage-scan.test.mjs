import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {scanLocalCodexUsage as scan,LOCAL_SCAN_LIMITS} from '../src/local-usage-scan.mjs';
const fixture=JSON.stringify({type:'session_meta',payload:{id:'11111111-1111-4111-8111-111111111111',source:'cli'}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:3,input_tokens:3,output_tokens:0}}}})+'\n'+JSON.stringify({type:'response_item',payload:{text:'PRIVATE MESSAGE NEVER RETURNED'}});
async function temp(t){const p=await fs.mkdtemp(path.join(os.tmpdir(),'codex-synthetic-scan-'));t.after(()=>fs.rm(p,{recursive:true,force:true}));return p;}
test('explicit directory only; returns projected usage and relative identities, not messages or root',async t=>{
 const root=await temp(t);await fs.writeFile(path.join(root,'one.jsonl'),fixture);await fs.writeFile(path.join(root,'ignored.txt'),'ignored');
 const r=await scan(root);assert.equal(r.filesRead,1);assert.equal(r.sessions[0].sourceId,'one.jsonl');assert.equal(r.sessions[0].snapshot.totalTokens,3);
 assert.ok(!JSON.stringify(r).includes(root));assert.ok(!JSON.stringify(r).includes('PRIVATE MESSAGE'));assert.equal(r.partial,false);
 await assert.rejects(()=>scan('relative'),/absolute/);await assert.rejects(()=>scan(),/absolute/);
});
test('symlink root/files/directories refused, including external targets',async t=>{
 const root=await temp(t),outside=await temp(t);await fs.writeFile(path.join(outside,'secret.jsonl'),fixture);
 try{await fs.symlink(outside,path.join(root,'external'),'dir');await fs.symlink(path.join(outside,'secret.jsonl'),path.join(root,'link.jsonl'));}catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip(`当前环境不能创建符号链接（${error.code}），无法验证 symlink 拒绝`);return;}throw error;}
 const r=await scan(root);assert.equal(r.filesRead,0);assert.equal(r.diagnosticCounts['symlink-refused'],2);assert.equal(r.partial,true);
 const q=await scan(path.join(root,'external'));assert.equal(q.diagnosticCounts['symlink-root-refused'],1);
});
test('invalid compressed logs, oversized files and depth have explicit partial diagnostics',async t=>{
 const root=await temp(t);await fs.writeFile(path.join(root,'log.jsonl.zst'),'not-decompressed');
 const handle=await fs.open(path.join(root,'huge.jsonl'),'w');await handle.truncate(LOCAL_SCAN_LIMITS.fileBytes+1);await handle.close();
 let folder=root;for(let i=0;i<9;i++){folder=path.join(folder,'d');await fs.mkdir(folder);}await fs.writeFile(path.join(folder,'deep.jsonl'),fixture);
 const r=await scan(root);assert.equal(r.filesRead,0);for(const code of [typeof zlib.zstdDecompress==='function'?'decompression-failed':'compression-runtime-unsupported','file-size-limit','depth-limit'])assert.equal(r.diagnosticCounts[code],1);
});

test('gzip and supported zstd logs import the same usage without exposing message text',async t=>{
 const root=await temp(t);await fs.writeFile(path.join(root,'one.jsonl.gz'),zlib.gzipSync(fixture));
 if(typeof zlib.zstdCompressSync==='function')await fs.writeFile(path.join(root,'two.jsonl.zst'),zlib.zstdCompressSync(fixture));
 const r=await scan(root);assert.equal(r.filesRead,typeof zlib.zstdCompressSync==='function'?2:1);assert.ok(r.sessions.every(row=>row.snapshot.totalTokens===3));assert.ok(!JSON.stringify(r).includes('PRIVATE MESSAGE'));
});
test('file count hard cap and total bytes hard cap with sparse synthetic files',async t=>{
 const root=await temp(t);for(let i=0;i<1001;i++)await fs.writeFile(path.join(root,`${i}.jsonl`),'');
 const r=await scan(root);assert.equal(r.filesRead,1000);assert.equal(r.diagnosticCounts['file-count-limit'],1);
 const large=await temp(t);for(let i=0;i<17;i++){const h=await fs.open(path.join(large,`${i}.jsonl`),'w');await h.truncate(LOCAL_SCAN_LIMITS.fileBytes);await h.close();}
 const q=await scan(large);assert.equal(q.bytesRead,LOCAL_SCAN_LIMITS.totalBytes);assert.equal(q.diagnosticCounts['total-size-limit'],1);
});
test('cancelled scan performs no file reads and errors expose no raw paths',async t=>{
 const root=await temp(t);await fs.writeFile(path.join(root,'one.jsonl'),fixture);const c=new AbortController();c.abort();
 const r=await scan(root,{signal:c.signal});assert.equal(r.filesRead,0);assert.equal(r.diagnosticCounts.cancelled,1);
 const q=await scan(path.join(root,'missing'));assert.equal(q.partial,true);assert.ok(!JSON.stringify(q).includes(root));
});
test('invalid UTF8 and malformed JSON report partial without raw input',async t=>{
 const root=await temp(t);await fs.writeFile(path.join(root,'bad.jsonl'),Buffer.from([0xff]));await fs.writeFile(path.join(root,'partial.jsonl'),'{"secret":');
 const r=await scan(root);assert.equal(r.diagnosticCounts['invalid-utf8'],1);assert.equal(r.diagnosticCounts['parser-diagnostics'],1);assert.ok(!JSON.stringify(r).includes('secret'));
});
test('EACCES stops that entry and does not retry it or expose exception contents',async t=>{
 const root=await temp(t),filename=path.join(root,'denied.jsonl');await fs.writeFile(filename,fixture);let attempts=0;
 const original=fs.open;t.mock.method(fs,'open',async function(name,...args){if(name===filename){attempts++;const e=new Error('PRIVATE '+filename);e.code='EACCES';throw e;}return original.call(fs,name,...args);});
 const r=await scan(root);assert.equal(attempts,1);assert.equal(r.diagnosticCounts['access-denied'],1);assert.equal(r.filesRead,0);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('growth while reading rejects captured log rather than claiming stable coverage',async t=>{
 const root=await temp(t),filename=path.join(root,'growing.jsonl');await fs.writeFile(filename,fixture);
 const original=fs.open;t.mock.method(fs,'open',async function(name,...args){const h=await original.call(fs,name,...args);if(name===filename){const read=h.read.bind(h);h.read=async(...readArgs)=>{const result=await read(...readArgs);await fs.appendFile(filename,'\n');return result;};}return h;});
 const r=await scan(root);assert.equal(r.filesRead,0);assert.equal(r.diagnosticCounts['file-changed-during-read'],1);assert.equal(r.sessions.length,0);
});
