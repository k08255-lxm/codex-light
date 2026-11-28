import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,symlink,rm,mkdir} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {DesktopState} from '../src/desktop-state.mjs';import {DEFAULT_PREFERENCES} from '../public/preferences.js';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'desktop-state-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return new DesktopState({root:path.join(root,'state')});}
test('preferences survive restart and a legacy receipt ledger is retired on the next save',async t=>{
 const state=await fixture(t);
 assert.deepEqual(await state.preferences(),DEFAULT_PREFERENCES);
 assert.deepEqual(await state.preferenceSnapshot(),{preferences:DEFAULT_PREFERENCES,firstRun:true});
 await assert.rejects(stat(state.root),{code:'ENOENT'});
 await mkdir(state.root);
 const preferences={...DEFAULT_PREFERENCES,theme:'light',keepAwakeDuringTask:true,desktopCompanion:'lulu',desktopCompanionSize:150};
 await writeFile(state.file,JSON.stringify({version:1,preferences,receipts:Array(1000).fill({state:'unknown'})}));
 assert.deepEqual(await state.preferences(),preferences);
 assert.deepEqual(await state.preferenceSnapshot(),{preferences,firstRun:false});
 const {keepAwakeDuringTask,desktopCompanion,desktopCompanionSize,...olderClient}=preferences;
 await state.preferences({...olderClient,theme:'dark'});
 assert.deepEqual(JSON.parse(await readFile(state.file,'utf8')),{version:2,preferences:{...preferences,theme:'dark'}});
 assert.equal((await new DesktopState({root:state.root}).preferences()).keepAwakeDuringTask,true);
});

test('damaged or unsafe preference files cannot be overwritten',async t=>{
 const state=await fixture(t);await mkdir(state.root);
 for(const data of ['{bad','x'.repeat(256*1024+1),JSON.stringify({version:9})]){
  await writeFile(state.file,data);
  await assert.rejects(state.preferences(DEFAULT_PREFERENCES));
  assert.equal(await readFile(state.file,'utf8'),data);
 }
 const linked=await fixture(t);await mkdir(linked.root);
 try{await symlink(state.file,linked.file);}catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code))return;throw error;}
 await assert.rejects(linked.preferences(DEFAULT_PREFERENCES));
});

test('desktop requests retain authenticated preferences and request deduplication independently of disk receipts',async t=>{
 const {createServer}=await import('../src/server.mjs');const state=await fixture(t);
 const app=await createServer({demo:true,desktop:true,desktopStateRoot:state.root});await app.started;t.after(()=>app.close());
 const call=(url,data,auth=true)=>fetch(app.origin+url,{method:data===undefined?'GET':'POST',headers:{...(auth?{Authorization:'Bearer '+app.token}:{}),'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
 assert.equal((await call('/api/desktop/preferences',undefined,false)).status,401);
 assert.equal((await call('/api/desktop/preferences',{preferences:DEFAULT_PREFERENCES,extra:true})).status,400);
 assert.equal((await call('/api/desktop/preferences',{preferences:DEFAULT_PREFERENCES})).status,200);
 const previous=await readFile(state.file,'utf8');
 const key=app.operations.serverInstance+':'+Date.now()+':test-operation';
 let count=0;
 const send=()=>app.operations.execute(key,'turn/start',{},()=>++count);
 assert.deepEqual(await Promise.all([send(),send()]),[1,1]);
 assert.equal(await readFile(state.file,'utf8'),previous);
 assert.equal((await call('/api/desktop/receipts')).status,405);
 assert.equal((await call('/api/desktop/receipts/ack',{requestIds:[key],confirmed:true})).status,404);
});
