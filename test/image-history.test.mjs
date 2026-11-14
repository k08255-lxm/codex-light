import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {UploadStore} from '../src/uploads.mjs';import {readInlineHistoryImage} from '../src/inline-history.mjs';import {ArtifactPreviewService} from '../src/artifacts.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=','base64');
const url='data:image/png;base64,'+png.toString('base64');
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'inline-image-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('images serialize as official inline input and survive staging cleanup',async t=>{
 const store=new UploadStore();t.after(()=>store.close());const f=await store.add(Readable.from([png]));const temp=store.resolve([f.id])[0].path;
 const result=await store.resolveInline([f.id]);assert.deepEqual(result,[{type:'image',url}]);assert.deepEqual(await store.resolveInline([f.id]),result);
 await store.close();await assert.rejects(stat(temp));assert.deepEqual(Buffer.from(result[0].url.split(',')[1],'base64'),png);
});
test('concurrent image resolves are stable and invalid IDs fail',async t=>{
 const store=new UploadStore();t.after(()=>store.close());const f=await store.add(Readable.from([png]));const [a,b]=await Promise.all([store.resolveInline([f.id]),store.resolveInline([f.id])]);assert.deepEqual(a,b);await assert.rejects(store.resolveInline(['foreign']));await assert.rejects(store.resolveInline([f.id,f.id]));
});
async function history(t,{meta='t1',labelPath,role='user'}={}){
 const root=await fixture(t),rollout=path.join(root,'rollout-date-t1.jsonl'),imagePath=path.join(root,'missing.png');
 const rows=[{type:'session_meta',payload:{id:meta}},{type:'response_item',payload:{type:'message',role,content:[{type:'input_text',text:`<image name=[Image #1] path="${labelPath||imagePath}">`},{type:'input_image',image_url:url}]}}];await writeFile(rollout,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');return {root,rollout,imagePath};
}
test('read-only exact legacy reference returns inline bytes, no file recovery',async t=>{
 const f=await history(t);const before=await readFile(f.rollout);const r=await readInlineHistoryImage({...f,threadId:'t1',roots:[f.root]});assert.deepEqual(r.bytes,png);await assert.rejects(stat(f.imagePath));assert.deepEqual(await readFile(f.rollout),before);
});
test('wrong scope, thread identity, role and path never return image',async t=>{
 for(const changes of [{meta:'other'},{role:'assistant'},{labelPath:'other.png'}]){const f=await history(t,changes);assert.equal(await readInlineHistoryImage({...f,threadId:'t1',roots:[f.root]}),null);}
 const f=await history(t);assert.equal(await readInlineHistoryImage({...f,threadId:'t1',roots:[path.join(f.root,'unrelated')]}),null);
});
test('artifact API prefers authorized inline bytes even when path is absent',async t=>{
 const f=await history(t),a=new ArtifactPreviewService({rolloutRoots:[f.root]});t.after(()=>a.close());a.bindThread({id:'t1',cwd:f.root,path:f.rollout});a.observe('t1',{type:'userMessage',content:[{type:'localImage',path:f.imagePath}]});
 const result=await a.preview({threadId:'t1',path:f.imagePath});assert.deepEqual(result.bytes,png);assert.equal(result.width,1);await assert.rejects(stat(f.imagePath));
});
