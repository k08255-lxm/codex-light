import test from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {RpcClient} from '../src/rpc.mjs';import {createServer} from '../src/server.mjs';
test('HTTP desktop receipt -> real stdio process inherits config home and submits schema-complete text',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'strict-send-'));
 const saved={CODEX_HOME:process.env.CODEX_HOME,TEST_EXPECTED_CODEX_HOME:process.env.TEST_EXPECTED_CODEX_HOME};
 let app;
 // One cleanup: close the server/child first, then remove the directory the child used as cwd.
 const cleanup=async()=>{try{if(app)await app.close();}finally{await rm(root,{recursive:true,force:true});}};
 t.after(cleanup);
 try{
  process.env.CODEX_HOME=root;process.env.TEST_EXPECTED_CODEX_HOME=root;
  const rpc=new RpcClient({command:process.execPath,args:[fileURLToPath(new URL('./strict-send-app-server.mjs',import.meta.url))],cwd:root,timeout:5000,closeTimeout:500});
  app=await createServer({client:rpc,desktop:true,desktopStateRoot:path.join(root,'state')});await app.started;
  assert.equal(rpc.connected,true,rpc.lastError||'synthetic app-server did not initialize');
  assert.equal((await rpc.call('config/read',{})).testInheritedHome,true);
  let seq=0;const post=async(method,params)=>{const response=await fetch(app.origin+'/api/rpc',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({method,params,requestId:app.operations.serverInstance+':'+Date.now()+':strict-test-'+(++seq)})});assert.equal(response.status,200);return response.json();};
  const thread=await post('thread/start',{cwd:root});assert.equal(thread.model,'configured-model');assert.equal(thread.inheritsPolicy,true);
  const result=await post('turn/start',{threadId:thread.thread.id,cwd:root,input:[{type:'text',text:'synthetic only'}]});assert.equal(result.turn.id,'test-turn');
 }finally{
  if(saved.CODEX_HOME===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=saved.CODEX_HOME;
  if(saved.TEST_EXPECTED_CODEX_HOME===undefined)delete process.env.TEST_EXPECTED_CODEX_HOME;else process.env.TEST_EXPECTED_CODEX_HOME=saved.TEST_EXPECTED_CODEX_HOME;
 }
});
