import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RuntimeAutomation,RuntimeAutomationStore} from '../src/runtime-automation.mjs';

const installed='0.160.0',newVersion='0.170.0';
const status=(version=installed,source='npm')=>({
 current:{source,version},npm:{available:true,version,path:'C:\\managed\\codex.exe'},desktop:{available:true,version:'0.165.0'},latest:{version:newVersion},
});
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'codex-light-engine-automation-'));
 t.after(()=>rm(root,{recursive:true,force:true}));const store=new RuntimeAutomationStore(root);
 const make=async()=>{const instance=new RuntimeAutomation({store});await instance.load();t.after(()=>instance.close());return instance;};
 return {store,make,automation:await make()};
}

test('defaults only check; opting in persists the source and a version for the next startup',async t=>{
 const f=await fixture(t);
 assert.equal(f.automation.snapshot().checkAutomatically,true);
 assert.equal(f.automation.snapshot().installOnRestart,false);
 await f.automation.consider(status());assert.equal(f.automation.snapshot().queuedVersion,null);
 await f.automation.configure({source:'npm',installOnRestart:true},status(installed,'desktop'));
 const reloaded=await f.make();assert.equal(reloaded.snapshot().source,'npm');assert.equal(reloaded.snapshot().queuedVersion,newVersion);
 const calls=[];const runtime={check:async()=>status(),upgrade:async(p,options)=>{calls.push(p,options);return {outcome:'succeeded',installedVersion:newVersion};},status:async()=>status(newVersion)};
 assert.equal(await reloaded.beforeEngineStart(runtime,'npm'),'C:\\managed\\codex.exe');
 assert.deepEqual(calls,[{version:newVersion,confirmed:true},{beforeEngineStart:true}]);
 assert.equal((await f.make()).snapshot().result.outcome,'succeeded');
 assert.equal((await f.make()).snapshot().queuedVersion,null);
});

test('one click queues only the displayed version for the next npm startup',async t=>{
 const f=await fixture(t),available={...status(),canQueueUpgrade:true};
 await assert.rejects(f.automation.configure({queueVersion:'1.0.0'},available));
 await f.automation.configure({queueVersion:newVersion},available);
 await f.automation.configure({queueVersion:null},available);
 assert.equal((await f.make()).snapshot().queuedVersion,null);
 await f.automation.configure({queueVersion:newVersion},available);
 const restarted=await f.make(),calls=[];
 assert.equal(restarted.snapshot().installOnRestart,false);
 await restarted.beforeEngineStart({check:async()=>status(),upgrade:async input=>{calls.push(input);return {outcome:'succeeded',installedVersion:newVersion};},status:async()=>status(newVersion)},'npm');
 assert.deepEqual(calls,[{version:newVersion,confirmed:true}]);
 const next=await f.make();assert.equal(next.snapshot().queuedVersion,null);
 await next.consider(status());assert.equal(next.snapshot().queuedVersion,null);
});

test('external sources never auto-install and an occupied npm installation remains deferred',async t=>{
 const f=await fixture(t);await f.automation.configure({installOnRestart:true},status());
 const never={check(){assert.fail('must not check');},upgrade(){assert.fail('must not install');}};
 assert.equal(await f.automation.beforeEngineStart(never,'wsl'),null);
 f.automation.explicit=true;assert.equal(await f.automation.beforeEngineStart(never,'npm'),null);
 f.automation.explicit=false;
 const occupied={check:async()=>status(),upgrade:async()=>{throw Object.assign(new Error('其他客户端占用 npm'),{code:'RUNTIME_EXTERNAL_IN_USE',outcome:'notExecuted'});}};
 assert.equal(await f.automation.beforeEngineStart(occupied,'npm'),null);
 assert.equal((await f.make()).snapshot().result.outcome,'deferred');assert.equal((await f.make()).snapshot().queuedVersion,newVersion);
 await f.automation.beforeEngineStart(never,'desktop');assert.equal((await f.make()).snapshot().queuedVersion,null);
});

test('interrupted or failed installations are visible and never silently retried',async t=>{
 const f=await fixture(t);await f.automation.configure({installOnRestart:true},status());
 await f.store.save({...await f.store.read(),result:{outcome:'installing',version:newVersion,at:new Date().toISOString()}});
 const restarted=await f.make();await restarted.consider(status());
 assert.equal(restarted.snapshot().queuedVersion,null);assert.equal(restarted.snapshot().result.outcome,'unknown');
 assert.equal(await restarted.beforeEngineStart({check(){assert.fail('should not retry');}},'npm'),null);
 await restarted.configure({installOnRestart:false},status());await restarted.configure({installOnRestart:true},status());
 assert.equal(restarted.snapshot().queuedVersion,newVersion);
 const failed={check:async()=>status(),upgrade:async()=>{throw Object.assign(new Error('验证失败'),{outcome:'notExecuted'});}};
 assert.equal(await restarted.beforeEngineStart(failed,'npm'),null);await restarted.consider(status());
 assert.equal(restarted.snapshot().result.outcome,'failed');assert.equal(restarted.snapshot().queuedVersion,null);
});

test('manual source validation rejects unavailable installations and leaves other preferences intact',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.automation.configure({source:'desktop'},{...status(),desktop:{available:false}}),/未找到可验证/);
 await assert.rejects(f.automation.configure({installOnRestart:true},status(installed,'desktop')),/选择全局 npm/);
 await f.automation.configure({checkAutomatically:false},status());
 assert.equal((await f.make()).snapshot().checkAutomatically,false);
 assert.equal((await f.make()).snapshot().source,'auto');
});
