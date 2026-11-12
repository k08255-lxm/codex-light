import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from '../src/server.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=','base64');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'artifacts-http-'));await fs.writeFile(path.join(root,'图标.png'),png);await fs.writeFile(path.join(root,'图标.svg'),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>');
 const projectStore={list:async()=>({projects:[{id:'registered-project',path:root}],selectedId:'registered-project'}),queue:Promise.resolve()};
 const app=await createServer({demo:true,projectStore});await app.started;t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});return {app,root};
}
const post=(app,body,extra={})=>fetch(app.origin+'/api/artifacts/preview',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});

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
