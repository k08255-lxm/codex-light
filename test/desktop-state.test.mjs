import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,symlink,rm,mkdir} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {DesktopState} from '../src/desktop-state.mjs';import {OperationStore} from '../src/operations.mjs';import {DEFAULT_PREFERENCES} from '../public/preferences.js';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'desktop-state-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return new DesktopState({root:path.join(root,'state')});}
function store(state){return new OperationStore({hooks:{before:r=>state.before(r),after:r=>state.after(r)}});}
const id=s=>s.serverInstance+':'+Date.now()+':test-operation';
test('missing read creates nothing; strict prefs and safe receipts survive new instance without payload',async t=>{
 const s=await fixture(t);assert.deepEqual(await s.preferences(),DEFAULT_PREFERENCES);await assert.rejects(stat(s.root),{code:'ENOENT'});
 const op=store(s),key=id(op);await op.execute(key,'turn/start',{prompt:'SECRET_PROMPT',token:'SECRET_TOKEN',cwd:'/private/path'},async()=>({authUrl:'https://secret',userCode:'SECRET_CODE',result:'SECRET_RESULT'}));
 const data=await readFile(s.file,'utf8');for(const secret of ['SECRET','authUrl','userCode','/private/path','prompt','token'])assert.ok(!data.includes(secret));
 const second=new DesktopState({root:s.root});assert.equal((await second.list())[0].state,'succeeded');assert.equal(store(second).get(key).state,'unknown');
 await assert.rejects(s.preferences({...DEFAULT_PREFERENCES,token:'x'}));await s.preferences({...DEFAULT_PREFERENCES,theme:'light'});assert.equal((await second.preferences()).theme,'light');
 await assert.rejects(s.ack(['unknown']));await assert.rejects(s.ack([key,key]));await s.ack([key]);assert.deepEqual(await s.list(),[]);
});
test('corrupt or oversized state blocks side effect rather than replacing records',async t=>{
 for(const kind of ['corrupt','large']){
  const s=await fixture(t);await mkdir(s.root);await writeFile(s.file,kind==='large'?'x'.repeat(256*1024+1):'{bad');
  const op=store(s);let ran=false;await assert.rejects(op.execute(id(op),'turn/start',{},async()=>{ran=true;}),{outcome:'notExecuted'});assert.equal(ran,false);
 }
});
test('symlink state blocks side effect rather than replacing records',async t=>{
 const s=await fixture(t);await mkdir(s.root);const target=path.join(s.root,'other');await writeFile(target,'{}');
 try{await symlink(target,s.file);}catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip(`当前环境不能创建符号链接（${error.code}），无法验证 symlink state 拒绝`);return;}throw error;}
 const op=store(s);let ran=false;await assert.rejects(op.execute(id(op),'turn/start',{},async()=>{ran=true;}),{outcome:'notExecuted'});assert.equal(ran,false);
});
test('pending is durable before execution; post-write failure retains pending and exposes warning',async t=>{
 const s=await fixture(t),op=store(s),key=id(op);const original=s.after.bind(s);
 s.after=async()=>{throw new Error('disk fail');};
 const result=await op.execute(key,'turn/start',{},async()=>{assert.equal((await s.list())[0].state,'pending');return {ok:true};});
 assert.deepEqual(result,{ok:true});assert.equal((await s.list())[0].state,'pending');assert.match(op.get(key).persistenceWarning,/已经执行/);s.after=original;
});
test('business outcomes requiring inspection are never recorded as success',async t=>{
 for(const [method,result] of [['plugin/apply',{outcome:'unknown'}],['git/apply',{outcome:'succeeded',exitCode:1}],['git/apply',{outcome:'unknown',exitCode:null}]]){
 const s=await fixture(t),op=store(s);await op.execute(id(op),method,{},async()=>result);assert.equal((await s.list())[0].state,'inspection');}
});
test('record ceiling blocks new mutation; receipts cannot carry arbitrary data',async t=>{
 const s=await fixture(t);const prefix='a'.repeat(32)+':'+Date.now()+':';
 await s.update(v=>{v.receipts=Array.from({length:1000},(_,i)=>({requestId:prefix+('record'+i).padEnd(10,'x'),method:'turn/start',createdAt:Date.now(),state:'pending',outcome:'pending'}));});
 const op=store(s);let ran=false;await assert.rejects(op.execute(id(op),'turn/start',{},()=>{ran=true;}));assert.equal(ran,false);
 await assert.rejects(s.update(v=>{v.receipts[0].token='bad';}));
});
test('desktop state API requires exact confirmed ack and authentication',async t=>{
 const {createServer}=await import('../src/server.mjs');const s=await fixture(t);const a=await createServer({demo:true,desktop:true,desktopStateRoot:s.root});await a.started;t.after(()=>a.close());
 const call=(url,data,auth=true)=>fetch(a.origin+url,{method:data===undefined?'GET':'POST',headers:{...(auth?{Authorization:'Bearer '+a.token}:{}),'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
 assert.equal((await call('/api/desktop/preferences',undefined,false)).status,401);
 assert.equal((await call('/api/desktop/preferences',{preferences:DEFAULT_PREFERENCES,extra:true})).status,400);
 assert.equal((await call('/api/desktop/preferences',{preferences:DEFAULT_PREFERENCES})).status,200);
 const key=id(a.operations);await a.operations.execute(key,'turn/start',{},()=>({ok:true}));
 assert.equal((await call('/api/desktop/receipts/ack',{requestIds:[key]})).status,400);
 assert.equal((await call('/api/desktop/receipts/ack',{requestIds:[key],confirmed:true})).status,200);
 assert.deepEqual((await(await call('/api/desktop/receipts')).json()).receipts,[]);
});
test('legacy desktop preferences migrate to codex without dropping receipts',async t=>{
 const s=await fixture(t);await mkdir(s.root,{recursive:true});
 const requestId='a'.repeat(32)+':'+Date.now()+':legacy-op';
 const legacy={version:1,theme:'light',fontScale:110,motion:'off',completionNotice:false,approvalNotice:true};
 await writeFile(s.file,JSON.stringify({version:1,preferences:legacy,receipts:[{requestId,method:'turn/start',createdAt:Date.now(),state:'succeeded',outcome:'succeeded'}]}));
 const second=new DesktopState({root:s.root});assert.deepEqual(await second.preferences(),{...legacy,visualStyle:'codex'});
 assert.deepEqual((await second.list()).map(receipt=>receipt.requestId),[requestId]);
 await second.preferences({...legacy,visualStyle:'claude'});
 const third=new DesktopState({root:s.root});assert.equal((await third.preferences()).visualStyle,'claude');
 assert.deepEqual((await third.list()).map(receipt=>receipt.requestId),[requestId]);
 const data=JSON.parse(await readFile(s.file,'utf8'));assert.equal(data.preferences.visualStyle,'claude');assert.equal(data.receipts[0].requestId,requestId);
});
test('runtime upgrade receipts are durable and minimal across desktop-state reload',async t=>{
 const s=await fixture(t),op=store(s),key=id(op),params={version:'0.167.1',confirmed:true},result={outcome:'succeeded',installedVersion:'0.167.1',restartRequired:true};
 assert.deepEqual(await op.execute(key,'runtime/upgrade',params,async()=>result),result);
 const [receipt]=await s.list();assert.equal(receipt.requestId,key);assert.equal(receipt.method,'runtime/upgrade');assert.equal(receipt.state,'succeeded');assert.equal(receipt.outcome,'succeeded');
 const data=await readFile(s.file,'utf8');for(const hidden of ['0.167.1','installedVersion','restartRequired','confirmed','SECRET'])assert.ok(!data.includes(hidden),hidden);
 const second=new DesktopState({root:s.root});const [restored]=await second.list();assert.equal(restored.requestId,key);assert.equal(restored.method,'runtime/upgrade');assert.equal(restored.state,'succeeded');assert.equal(store(second).get(key).state,'unknown');
});
test('runtime upgrade unknown receipt survives reload and is never stored as success',async t=>{
 const s=await fixture(t),op=store(s),key=id(op);
 await assert.rejects(op.execute(key,'runtime/upgrade',{version:'0.167.1',confirmed:true},async()=>{throw new Error('network interrupted');}),{outcome:'unknown'});
 const [receipt]=await s.list();assert.equal(receipt.method,'runtime/upgrade');assert.equal(receipt.state,'unknown');assert.equal(receipt.outcome,'unknown');
 const data=await readFile(s.file,'utf8');assert.ok(!data.includes('network interrupted'));
 const second=new DesktopState({root:s.root});const [restored]=await second.list();assert.equal(restored.state,'unknown');assert.equal(restored.outcome,'unknown');
});
test('config receipts classify business unknown, conflict, ok and overridden writes',async t=>{
 for(const [result,state,outcome] of [
  [{outcome:'unknown'},'inspection','inspection'],
  [{outcome:'not-executed',reason:'conflict'},'failed','notExecuted'],
  [{outcome:'succeeded',status:'ok'},'succeeded','succeeded'],
  [{outcome:'succeeded',status:'okOverridden',effective:false},'succeeded','succeeded']
 ]){
  const s=await fixture(t),op=store(s),key=id(op);
  assert.deepEqual(await op.execute(key,'config/apply',{},async()=>result),result);
  const [receipt]=await s.list();assert.equal(receipt.state,state);assert.equal(receipt.outcome,outcome);
  assert.deepEqual(op.get(key).result,result); // Preserve original effective/overridden semantics for UI.
 }
});
