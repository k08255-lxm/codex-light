import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
import {HistoryImages} from '../src/history-images.mjs';
import {ItemStore} from '../public/store.js';
import {artifactCandidates} from '../public/ui/artifacts.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=','base64');
async function fixture(t,client){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'artifacts-http-'));await fs.writeFile(path.join(root,'图标.png'),png);await fs.writeFile(path.join(root,'图标.svg'),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>');
 const projectStore={list:async()=>({projects:[{id:'registered-project',path:root}],selectedId:'registered-project'}),queue:Promise.resolve()};
 const app=await createServer({demo:true,projectStore,client});await app.started;t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});return {app,root};
}
const post=(app,body,extra={})=>fetch(app.origin+'/api/artifacts/preview',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});

test('history can deliver a compact reference and the same original PNG through the scoped binary endpoint',async t=>{
 const client=new DemoClient(), {app}=await fixture(t,client);
 const image={id:'generated',type:'imageGeneration',status:'completed',savedPath:'out.png',result:png.toString('base64')};
 client.items.set('pictures',[{turnId:'t',item:image}]);
 const params={threadId:'pictures',limit:60,sortDirection:'desc'};
 const read=async flags=>(await fetch(app.origin+'/api/rpc',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({method:'thread/items/list',params,...flags})})).json();
 const raw=await read({});assert.equal(raw.data[0].item.result,image.result);
 const lean=await read({historyImages:'deferred'});assert.ok(!JSON.stringify(lean).includes(image.result));
 const store=new ItemStore();store.upsert(lean.data[0].item);
 const [card]=artifactCandidates(store.items.get(image.id));
 assert.equal(card.path,'out.png');assert.equal(card.historyImage.itemId,image.id);
 const response=await post(app,{threadId:'pictures',historyImage:card.historyImage});
 assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
 assert.equal((await post(app,{threadId:'another',historyImage:card.historyImage})).status,404);
 assert.equal((await post(app,{threadId:'pictures',path:'out.png',historyImage:card.historyImage})).status,400);
});

test('evicted historical image recovers across a shifted page, rejects changed bytes and expires on reset',async()=>{
 const gen={id:'pic',type:'imageGeneration',status:'completed',result:png.toString('base64')};
 const row={turnId:'t',item:gen}, filler={turnId:'t',item:{id:'new',type:'agentMessage',text:'newer'}};
 let calls=0;
 const media=new HistoryImages(async(method,params)=>{calls++;return params.cursor?{data:[row],nextCursor:null}:{data:[filler],nextCursor:'older'};},{budget:0});
 const input={threadId:'thread',limit:1,sortDirection:'desc'};
 const page=media.project('thread/items/list',input,{data:[row]});
 const [{historyImage}]=artifactCandidates(page.data[0].item);
 assert.deepEqual((await media.read({threadId:'thread',historyImage})).bytes,png);
 assert.ok(calls>=2);
 gen.result=Buffer.concat([png,Buffer.from('changed')]).toString('base64');
 await assert.rejects(media.read({threadId:'thread',historyImage}),/已更新/);
 media.clear();const before=calls;
 await assert.rejects(media.read({threadId:'thread',historyImage}),/引用已失效/);
 assert.equal(calls,before);
});

test('artifact preview requires normal bearer and same origin, never a token URL',async t=>{
 const {app}=await fixture(t);const input={projectId:'registered-project',path:'图标.png'};
 assert.equal((await fetch(app.origin+'/api/artifacts/preview?token='+app.token,{method:'POST',body:JSON.stringify(input)})).status,401);
 assert.equal((await post(app,input,{Origin:'https://outside.invalid'})).status,403);
 const response=await post(app,input);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('x-artifact-width'),'1');assert.equal(response.headers.get('x-artifact-height'),'1');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(response.headers.get('content-disposition'),/^attachment;/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
});

test('thread preview is bound only by an actual returned thread and SVG stays an image-only binary response',async t=>{
 const {app,root}=await fixture(t);assert.equal((await post(app,{threadId:'invented',path:'图标.svg'})).status,403);
 const created=await fetch(app.origin+'/api/rpc',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({method:'thread/start',params:{cwd:root},requestId:app.operations.serverInstance+':'+Date.now()+':artifact-thread-start'})});assert.equal(created.status,200);const {thread}=await created.json();
 const image=await post(app,{threadId:thread.id,path:'图标.svg'});assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/svg+xml');assert.match(image.headers.get('content-security-policy'),/sandbox;/);assert.match(image.headers.get('content-security-policy'),/script-src 'none'/);assert.match(image.headers.get('content-security-policy'),/object-src 'none'/);assert.match(await image.text(),/^<svg /);
 for(const input of [{threadId:thread.id,cwd:root,path:'图标.png'},{projectId:'registered-project',path:'../elsewhere.png'},{projectId:'registered-project',path:'auth.json'},{projectId:'registered-project',path:'http://example.invalid/icon.png'}])assert.ok((await post(app,input)).status>=400);
});
