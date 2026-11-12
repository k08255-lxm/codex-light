import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {FileAttachmentStore,FILE_ATTACHMENT_LIMITS,defaultAttachmentRoot} from '../src/file-attachments.mjs';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-attachments-synthetic-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,store:new FileAttachmentStore({root})};}
async function* bytes(value='sample'){yield Buffer.from(value);}
const meta={filename:'sample.txt',mime:'text/plain'};
test('explicit uploaded bytes stored safely; only owned IDs resolve; close preserves disk',async t=>{
 const {root,store}=await fixture(t),file=await store.add(bytes(),meta);assert.equal(await fs.readFile(file.path,'utf8'),'sample');assert.equal(file.category,'text');assert.equal(path.basename(file.path),'attachment.txt');assert.equal(file.name,'sample.txt');
 assert.deepEqual(await store.resolve([file.id]),[file]);assert.equal(store.listOwned().length,1);
 await assert.rejects(()=>store.resolve(['foreign']),/not owned/);await assert.rejects(()=>new FileAttachmentStore({root}).resolve([file.id]),/not owned/);
 await store.close();assert.equal(await fs.readFile(file.path,'utf8'),'sample');assert.equal(store.listOwned().length,0);await assert.rejects(()=>store.resolve([file.id]),/closed/);
});
test('policy rejects unsafe names and executable/image uploads; MIME conflict stays unknown',async t=>{
 const {store}=await fixture(t);for(const filename of ['/a.txt','C:\\a.txt','a.exe','script.js'])await assert.rejects(()=>store.add(bytes(),{...meta,filename}));
 await assert.rejects(()=>store.add(bytes(),{filename:'a.png',mime:'image/png'}),/image/);
 const file=await store.add(bytes(),{filename:'a.pdf',mime:'text/plain'});assert.equal(file.category,'unknown');assert.equal(file.riskWarning,true);assert.match(file.warning,/not executed/);
 const zip=await store.add(bytes(),{filename:'a.zip',mime:'application/zip'});assert.equal(zip.riskWarning,true);
});
test('oversize and failing streams clean only this attempt, not historical cache',async t=>{
 const {root,store}=await fixture(t);await fs.writeFile(path.join(root,'history.txt'),'keep');
 async function* huge(){yield Buffer.alloc(FILE_ATTACHMENT_LIMITS.fileBytes);yield Buffer.from('x');}
 await assert.rejects(()=>store.add(huge(),meta),/size/);assert.deepEqual(await fs.readdir(root),['history.txt']);
 async function* broken(){yield Buffer.from('part');throw Error('failure');}
 await assert.rejects(()=>store.add(broken(),meta),/failure/);assert.equal(await fs.readFile(path.join(root,'history.txt'),'utf8'),'keep');assert.equal(store.listOwned().length,0);
});
test('persistent cache quota includes historical files and does not delete them',async t=>{
 const {root,store}=await fixture(t);const historical=path.join(root,'historical.bin'),h=await fs.open(historical,'w');await h.truncate(FILE_ATTACHMENT_LIMITS.cacheBytes);await h.close();
 await assert.rejects(()=>store.add(bytes(),meta),/200 MiB/);assert.equal((await fs.stat(historical)).size,FILE_ATTACHMENT_LIMITS.cacheBytes);assert.deepEqual(await fs.readdir(root),['historical.bin']);
});
test('instance count, resolve cap, explicit deletion',async t=>{
 const {store}=await fixture(t);const files=[];for(let i=0;i<20;i++)files.push(await store.add(bytes(),meta));
 await assert.rejects(()=>store.add(bytes(),meta),/20 files/);await assert.rejects(()=>store.resolve(files.slice(0,6).map(f=>f.id)),/5 distinct/);
 await store.deleteOwned(files[0].id);await assert.rejects(()=>fs.stat(files[0].path),{code:'ENOENT'});assert.equal(store.listOwned().length,19);
 await assert.rejects(()=>store.deleteOwned('foreign'),/not owned/);
});
test('symlink roots and injected cache symlinks refused',async t=>{
 const {root,store}=await fixture(t),outside=await fs.mkdtemp(path.join(os.tmpdir(),'codex-attachments-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
 try{await fs.symlink(outside,path.join(root,'link'),'dir');}catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip(`当前环境不能创建符号链接（${error.code}），无法验证 symlink root 拒绝`);return;}throw error;}
 await assert.rejects(()=>store.add(bytes(),meta),/symlink/);
 const linked=new FileAttachmentStore({root:path.join(root,'link')});await assert.rejects(()=>linked.add(bytes(),meta),/symlink/);assert.deepEqual(await fs.readdir(outside),[]);
});
test('foreign lock is not removed or bypassed and modified references rejected',async t=>{
 const {root,store}=await fixture(t);await fs.mkdir(path.join(root,'.upload-lock'));await assert.rejects(()=>store.add(bytes(),meta),/busy/);assert.equal((await fs.stat(path.join(root,'.upload-lock'))).isDirectory(),true);
 await fs.rmdir(path.join(root,'.upload-lock'));const file=await store.add(bytes(),meta);await fs.writeFile(file.path,'changed');await assert.rejects(()=>store.resolve([file.id]),/changed/);
});
test('production default uses user data root, no source file reading',()=>{
 // defaultAttachmentRoot selects the base by injected platform but uses the host path module (src/file-attachments.mjs:9-11).
 const hostPath=process.platform==='win32'?path.win32:path.posix;
 assert.equal(defaultAttachmentRoot({platform:'linux',env:{XDG_DATA_HOME:'/synthetic-data'},home:'/unused'}),hostPath.join('/synthetic-data','CodexLight','attachments'));assert.throws(()=>new FileAttachmentStore({root:'relative'}),/absolute/);
});
test('concurrent same-name uploads serialize without overwrites; aborted upload cleans up',async t=>{
 const {root,store}=await fixture(t);const [a,b]=await Promise.all([store.add(bytes('one'),meta),store.add(bytes('two'),meta)]);assert.notEqual(a.path,b.path);assert.equal(await fs.readFile(a.path,'utf8'),'one');assert.equal(await fs.readFile(b.path,'utf8'),'two');
 const second=new FileAttachmentStore({root});let release;async function* waiting(){yield Buffer.from('pending');await new Promise(r=>release=r);yield Buffer.from('more');}
 const pending=second.add(waiting(),meta);while(!release)await new Promise(r=>setImmediate(r));const closing=second.close();release();await assert.rejects(()=>pending,/closed/);await closing;
 assert.equal((await fs.readdir(root)).length,2);assert.equal(await fs.readFile(a.path,'utf8'),'one');
});
