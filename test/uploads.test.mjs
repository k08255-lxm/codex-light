import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';import {readFile,stat} from 'node:fs/promises';import {UploadStore,imageType} from '../src/uploads.mjs';
const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
const stream=bytes=>Readable.from([bytes]);
test('image magic accepted, arbitrary files/SVG rejected',()=>{
 assert.equal(imageType(png).mime,'image/png');assert.equal(imageType(Buffer.from('GIF89a')).mime,'image/gif');
 assert.equal(imageType(Buffer.from('<svg onload="alert(1)"></svg>')),null);assert.equal(imageType(Buffer.from('MZexecutable')),null);
});
test('opaque local image IDs, sanitized names, no source path disclosure',async t=>{
 const store=new UploadStore();t.after(()=>store.close());const file=await store.add(stream(png),{filename:'../../secret\n.png'});assert.equal(file.name,'secret.png');assert.equal(file.path,undefined);
 const input=store.resolve([file.id]);assert.equal(input[0].type,'localImage');assert.equal((await readFile(input[0].path)).equals(png),true);
 await assert.rejects(store.add(stream(Buffer.from('not image'))),/只支持/);assert.throws(()=>store.resolve(['../secret']),/不存在/);assert.throws(()=>store.resolve([file.id,file.id]),/不同图片/);
});
test('bounded upload file size, count, aggregate; deletion only removes own copy',async t=>{
 const store=new UploadStore({maxFile:20,maxTotal:20,maxFiles:1});t.after(()=>store.close());
 await assert.rejects(store.add(stream(Buffer.concat([png,Buffer.alloc(100)]))),/不能超过/);
 const f=await store.add(stream(png));const p=store.resolve([f.id])[0].path;await assert.rejects(store.add(stream(png)),/数量/);assert.equal(await store.remove(f.id),true);await assert.rejects(stat(p),/ENOENT/);assert.equal(store.total,0);
});
test('parallel aggregate limit and closed lifetime',async()=>{
 const store=new UploadStore({maxTotal:png.length,maxFiles:5});const results=await Promise.allSettled([store.add(stream(png)),store.add(stream(png))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const p=store.resolve([results.find(r=>r.status==='fulfilled').value.id])[0].path;await store.close();await assert.rejects(stat(p),/ENOENT/);await assert.rejects(store.add(stream(png)),/已关闭/);
});
test('close waits for in-flight persistence, is idempotent and resets accounting',async()=>{
 const store=new UploadStore();let release,entered;const gate=new Promise(r=>release=r), started=new Promise(r=>entered=r);
 const original=store.directory.bind(store);store.directory=async()=>{const dir=await original();entered(dir);await gate;return dir;};
 const add=store.add(stream(png));const rejected=assert.rejects(add,/已关闭/);const dir=await started;
 const close=store.close();assert.equal(store.close(),close);let done=false;close.then(()=>done=true);await Promise.resolve();assert.equal(done,false);
 release();await Promise.all([close,rejected]);assert.equal(store.total,0);assert.equal(store.reserved,0);await assert.rejects(stat(dir),/ENOENT/);
});
