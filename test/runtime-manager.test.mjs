import {EventEmitter} from 'node:events';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {rename as fsRename} from 'node:fs/promises';
import {PassThrough} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeManager} from '../src/runtime-manager.mjs';

const NOW=1700000000000;
const response=(version,{ok=true,status=200,body,headers={}}={})=>({
 ok,status,
 headers:{get:name=>headers[name.toLowerCase()]??null},
 text:async()=>body===undefined?JSON.stringify({version}):body,
});
const fetchVersion=version=>async()=>response(version);
const STATUS_KEYS=['blockedReason','canUpgrade','current','desktop','latest','npm','upgrading'];
function assertStatusShape(status){
 for(const key of STATUS_KEYS)assert.ok(Object.hasOwn(status,key),`missing status.${key}`);
 assert.deepEqual(Object.keys(status).filter(key=>!STATUS_KEYS.includes(key)).sort(),Object.hasOwn(status,'diagnostics')?['diagnostics']:[]);
 if(Object.hasOwn(status,'diagnostics')){assert.ok(Array.isArray(status.diagnostics));assert.ok(status.diagnostics.length>0);}
}
function assertLatestShape(latest,{stale=false}={}){
 assert.deepEqual(Object.keys(latest).sort(),(stale?['checkedAt','stale','version']:['checkedAt','version']).sort());
 assert.equal(latest.stale,stale?true:undefined);
}
const readVersion=file=>{
 try{const match=/codex-cli\s+([0-9][0-9A-Za-z.-]*)/.exec(readFileSync(file,'utf8'));return match?.[1]||null;}catch{return null;}
};
const x64Exe=packageRoot=>path.join(packageRoot,'node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
const legacyX64Exe=packageRoot=>path.join(packageRoot,'vendor','x86_64-pc-windows-msvc','codex','codex.exe');
function writePackage(packageRoot,version,{exeVersion=version,marker='package',layout='nested'}={}){
 mkdirSync(packageRoot,{recursive:true});
 writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify({name:'@openai/codex',version}));
 const executable=layout==='legacy'?legacyX64Exe(packageRoot):x64Exe(packageRoot);mkdirSync(path.dirname(executable),{recursive:true});
 writeFileSync(executable,`codex-cli ${exeVersion}\n`);
 writeFileSync(path.join(packageRoot,'marker.txt'),marker);
 return executable;
}
function snapshot(root){
 const result={};
 const visit=dir=>{
  for(const name of readdirSync(dir,{withFileTypes:true})){
   const target=path.join(dir,name.name);
   if(name.isDirectory())visit(target);else result[path.relative(root,target)]=readFileSync(target).toString('base64');
  }
 };
 visit(root);return result;
}
function leftovers(parent){return readdirSync(parent).filter(name=>name.startsWith('.codex-light-')).sort();}

function filesystemFixture(t,{oldVersion='0.157.1',oldLayout='nested'}={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'codex-light-transaction-'));
 t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100}));
 const appData=path.join(root,'AppData','Roaming');
 const packageRoot=path.join(appData,'npm','node_modules','@openai','codex');
 const npmPath=writePackage(packageRoot,oldVersion,{marker:'old',layout:oldLayout});
 const desktopPath=path.join(root,'desktop','codex.exe');mkdirSync(path.dirname(desktopPath),{recursive:true});
 writeFileSync(desktopPath,'codex-cli 0.167.0-alpha.3.2\n');
 const npmCliPath=path.join(root,'node','node_modules','npm','bin','npm-cli.js');mkdirSync(path.dirname(npmCliPath),{recursive:true});writeFileSync(npmCliPath,'// npm-cli fixture\n');
 const nodePath=path.join(root,'node','node.exe');writeFileSync(nodePath,'');
 return {root,appData,packageRoot,npmPath,desktopPath,npmCliPath,nodePath,before:snapshot(packageRoot)};
}

function installerHarness(){
 const behavior={hang:false,error:null,code:0,data:'',write:true,stagePackageVersion:null,stageExeVersion:null,beforeClose:null};
 const calls=[];
 const spawnFn=(command,args,options)=>{
  const prefix=args[args.indexOf('--prefix')+1];
  const target=args[args.length-1].slice('@openai/codex@'.length);
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let closed=false;
  const close=code=>{if(closed)return;closed=true;child.emit('exit',code);child.emit('close',code);};
  child.kill=()=>{if(behavior.killCloses!==false)setImmediate(()=>close(null));};
  calls.push({command,args,options,child,prefix,target,close});
  setImmediate(()=>{
   if(behavior.error){child.emit('error',new Error('spawn failed'));return;}
   if(behavior.hang)return;
   if(behavior.write){
    const packageVersion=behavior.stagePackageVersion||target;
    writePackage(path.join(prefix,'node_modules','@openai','codex'),packageVersion,{exeVersion:behavior.stageExeVersion||packageVersion,marker:'staged'});
   }
   if(behavior.data)child.stdout.write(behavior.data);
   behavior.beforeClose?.();
   close(behavior.code);
  });
  return child;
 };
 return {spawnFn,calls,behavior,set(values){Object.assign(behavior,values);}};
}

function transactionManager(t,fixture,{installer=installerHarness(),fsOps,versionOf,stageTimeoutMs=1000,currentPath}={}){
 const rpc=new EventEmitter();rpc.requests=new Map();
 const manager=new RuntimeManager({
  currentPath:currentPath||fixture.desktopPath,currentSource:'desktop',platform:'win32',arch:'x64',env:{APPDATA:fixture.appData},
  exists:existsSync,discoverDesktop:()=>null,versionOf:versionOf||readVersion,packageRoot:fixture.packageRoot,npmCliPath:fixture.npmCliPath,node:fixture.nodePath,
  spawnFn:installer.spawnFn,fetchFn:fetchVersion('0.167.1'),operations:{entries:new Map()},rpc,now:()=>NOW,stageTimeoutMs,fs:fsOps,
 });
 t.after(()=>manager.close());
 return {manager,installer};
}

function legacySetup({versions={npm:'0.157.1',desktop:'0.167.0-alpha.3.2'},currentPath,operations={entries:new Map()},rpc=new EventEmitter(),now=()=>NOW}={}){
 rpc.requests=rpc.requests||new Map();
 const npmPath='C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
 const desktopLocation='C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__abc';
 const desktopPath=desktopLocation+'\\app\\resources\\codex.exe';
 const npmCliPath='C:\\node\\node_modules\\npm\\bin\\npm-cli.js';
 const probes=[];
 const versionOf=executable=>{probes.push(executable);return executable===npmPath?versions.npm:executable===desktopPath?versions.desktop:null;};
 const manager=new RuntimeManager({
  currentPath:currentPath||desktopPath,currentSource:'desktop',platform:'win32',arch:'x64',env:{APPDATA:'C:\\Users\\u\\AppData\\Roaming'},
  exists:p=>[npmPath,desktopPath,npmCliPath].includes(p),discoverDesktop:()=>desktopLocation,versionOf,npmCliPath,node:'C:\\node\\node.exe',
  spawnFn:()=>{throw new Error('must not spawn');},fetchFn:fetchVersion('0.167.1'),operations,rpc,now,
 });
 return {manager,rpc,operations,probes};
}
async function checkedLegacy(options={}){const context=legacySetup(options);await context.manager.check();return context;}

test('status is read-only, cached, reports candidates, and never calls fetch',async t=>{
 let fetched=0;const ctx=legacySetup();ctx.manager.fetchFn=async()=>{fetched++;throw new Error('must not fetch');};t.after(()=>ctx.manager.close());
 const first=await ctx.manager.status();const probesAfterFirst=ctx.probes.length;const second=await ctx.manager.status();
 assert.equal(fetched,0);assert.equal(ctx.probes.length,probesAfterFirst,'status should reuse its short cache');
 assert.deepEqual(Object.keys(first.current).sort(),['path','source','version']);
 assertStatusShape(first);
 assert.deepEqual(Object.keys(first.npm).sort(),['available','path','version']);assert.deepEqual(Object.keys(first.desktop).sort(),['available','path','version']);
 assert.equal(first.current.path.includes('WindowsApps'),true);assert.equal(first.current.version,'0.167.0-alpha.3.2');
 assert.equal(first.npm.available,true);assert.equal(first.npm.version,'0.157.1');
 assert.equal(first.desktop.available,true);assert.equal(first.desktop.version,'0.167.0-alpha.3.2');
 assert.equal(first.latest,null);assert.equal(first.canUpgrade,false);assert.match(first.blockedReason,/检查更新/);
 assert.equal(second.npm.version,'0.157.1');
});

test('version probe diagnostics are enumerable in status JSON',async t=>{
 const ctx=legacySetup({versions:{npm:'0.157.1',desktop:null}});t.after(()=>ctx.manager.close());
 const status=await ctx.manager.status();
 assertStatusShape(status);
 assert.ok(status.diagnostics.some(line=>/版本/.test(line)));
 assert.deepEqual(JSON.parse(JSON.stringify(status)).diagnostics,status.diagnostics);
});

test('check uses the fixed registry URL, rejects redirects, and keeps only stable version metadata',async t=>{
 const calls=[];const ctx=legacySetup();ctx.manager.fetchFn=async(url,options)=>{calls.push({url,options});return response('0.167.1');};t.after(()=>ctx.manager.close());
 const status=await ctx.manager.check();
 assert.deepEqual(calls[0],{url:'https://registry.npmjs.org/@openai%2Fcodex/latest',options:{redirect:'error',signal:calls[0].options.signal}});
 assert.ok(calls[0].options.signal instanceof AbortSignal);
 assert.equal(status.latest.version,'0.167.1');assert.match(status.latest.checkedAt,/^\d{4}-\d\d-\d\dT.*Z$/);
 assertLatestShape(status.latest);assertStatusShape(status);assert.equal(status.canUpgrade,true);
 for(const version of ['0.167.1-beta.1','v0.167.1','01.2.3','0.167.1+build']){
  const bad=legacySetup();bad.manager.fetchFn=fetchVersion(version);t.after(()=>bad.manager.close());
  await assert.rejects(bad.manager.check(),/稳定 SemVer/);
 }
});

test('failed checks mark the old result stale and throw instead of silently falling back',async t=>{
 let fail=false;const ctx=legacySetup();ctx.manager.fetchFn=async()=>{if(fail)throw new Error('network down');return response('0.167.1');};t.after(()=>ctx.manager.close());
 await ctx.manager.check();fail=true;await assert.rejects(ctx.manager.check(),/network down/);
 const status=await ctx.manager.status();
 assert.equal(status.latest.stale,true);assert.equal(status.canUpgrade,false);assert.match(status.blockedReason,/过期/);
 assertLatestShape(status.latest,{stale:true});assert.equal(JSON.parse(JSON.stringify(status)).latest.stale,true);
});

test('check bounds and times out without waiting forever',async t=>{
 const large=legacySetup();large.manager.fetchFn=async()=>response('0.167.1',{body:'x'.repeat(300*1024)});t.after(()=>large.manager.close());
 await assert.rejects(large.manager.check(),/响应过大/);
 const stalled=legacySetup();stalled.manager.checkTimeoutMs=10;stalled.manager.fetchFn=(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true}));t.after(()=>stalled.manager.close());
 await assert.rejects(stalled.manager.check(),/aborted/);
});

test('non-Windows status reports unsupported transactions while preserving version detection',async t=>{
 const manager=new RuntimeManager({currentPath:'/opt/codex/codex',currentSource:'configured',platform:'linux',arch:'x64',env:{PATH:''},exists:()=>false,versionOf:()=>null,now:()=>NOW});
 t.after(()=>manager.close());
 const status=await manager.status();
 assert.equal(status.canUpgrade,false);assert.match(status.blockedReason,/暂不支持/);
});

test('upgrade validates recent check, confirmation, exact target, and unknown keys before touching files',async t=>{
 const ctx=await checkedLegacy();t.after(()=>ctx.manager.close());
 await assert.rejects(ctx.manager.upgrade({version:'0.167.1',confirmed:true,extra:1}),/不支持参数 extra/);
 await assert.rejects(ctx.manager.upgrade({version:'0.167.1',confirmed:false}),/明确确认/);
 await assert.rejects(ctx.manager.upgrade({version:'0.167.2',confirmed:true}),/最近一次检查/);
 const expired=await checkedLegacy();expired.manager.now=()=>NOW+20*60*1000+1;t.after(()=>expired.manager.close());
 await assert.rejects(expired.manager.upgrade({version:'0.167.1',confirmed:true}),/20 分钟|过期/);
});

test('busy active turns, approvals, and other pending operations block before spawn',async t=>{
 const rpc=new EventEmitter();const operations={entries:new Map()};const ctx=await checkedLegacy({rpc,operations});t.after(()=>ctx.manager.close());
 rpc.emit('event',{method:'turn/started',params:{turn:{id:'turn-1'}}});
 await assert.rejects(ctx.manager.upgrade({version:'0.167.1',confirmed:true}),/运行中的任务/);
 rpc.emit('event',{method:'turn/completed',params:{turn:{id:'turn-1'}}});
 rpc.requests.set('approval',{});
 await assert.rejects(ctx.manager.upgrade({version:'0.167.1',confirmed:true}),/待处理审批/);
 rpc.requests.clear();operations.entries.set('other',{state:'pending'});
 await assert.rejects(ctx.manager.upgrade({version:'0.167.1',confirmed:true}),/未完成操作/);
});

test('Windows in-use and untrusted npm-cli checks reject before any spawn',async t=>{
 const inUse=await checkedLegacy({currentPath:'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'});t.after(()=>inUse.manager.close());
 await assert.rejects(inUse.manager.upgrade({version:'0.167.1',confirmed:true}),{code:'RUNTIME_IN_USE',outcome:'notExecuted'});
 const badCli=await checkedLegacy();t.after(()=>badCli.manager.close());badCli.manager.npmCliPath='npm.cmd';badCli.manager.exists=()=>true;
 await assert.rejects(badCli.manager.upgrade({version:'0.167.1',confirmed:true}),{code:'RUNTIME_NPM_CLI_MISSING',outcome:'notExecuted'});
});

test('staged install uses fixed prefix argv, never writes the existing package, then swaps and probes successfully',async t=>{
 const fixture=filesystemFixture(t);const installer=installerHarness();let observed=null;
 installer.set({beforeClose:()=>{observed=snapshot(fixture.packageRoot);}});
 const {manager}=transactionManager(t,fixture,{installer});await manager.check();
 const result=await manager.upgrade({version:'0.167.1',confirmed:true});
 assert.deepEqual(result,{outcome:'succeeded',installedVersion:'0.167.1',restartRequired:true});
 assert.equal(installer.calls.length,1);const call=installer.calls[0];
 assert.deepEqual(call.args,[fixture.npmCliPath,'install','--global','--prefix',call.prefix,'--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org','@openai/codex@0.167.1']);
 assert.equal(call.command,fixture.nodePath);assert.equal(call.options.cwd,call.prefix);assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);
 assert.deepEqual(observed,fixture.before,'npm stage must not modify the existing package');
 assert.equal(JSON.parse(readFileSync(path.join(fixture.packageRoot,'package.json'),'utf8')).version,'0.167.1');
 assert.equal(readVersion(fixture.npmPath),'0.167.1');
 const after=await manager.status();assert.equal(after.npm.version,'0.167.1');assert.equal(after.canUpgrade,false);
 assert.equal(existsSync(call.prefix),false);assert.deepEqual(leftovers(path.dirname(fixture.packageRoot)),[]);
});

test('legacy vendor exe layout migrates to nested layout without a false rollback',async t=>{
 const fixture=filesystemFixture(t,{oldLayout:'legacy'});const installer=installerHarness();
 assert.match(fixture.npmPath,/vendor[\\/]x86_64-pc-windows-msvc[\\/]codex[\\/]codex\.exe$/);
 const {manager}=transactionManager(t,fixture,{installer});await manager.check();
 const result=await manager.upgrade({version:'0.167.1',confirmed:true});
 assert.deepEqual(result,{outcome:'succeeded',installedVersion:'0.167.1',restartRequired:true});
 assert.equal(existsSync(fixture.npmPath),false,'legacy exe path should be gone after migration');
 const nested=x64Exe(fixture.packageRoot);
 assert.equal(existsSync(nested),true);assert.equal(readVersion(nested),'0.167.1');
 const status=await manager.status();assert.equal(status.npm.path,nested);assert.equal(status.npm.version,'0.167.1');
 assert.deepEqual(leftovers(path.dirname(fixture.packageRoot)),[]);
});

test('stage timeout and wrong staged version leave the old package byte-identical',async t=>{
 const timeoutFixture=filesystemFixture(t);const timeoutInstaller=installerHarness();timeoutInstaller.set({hang:true});
 const timeout=transactionManager(t,timeoutFixture,{installer:timeoutInstaller,stageTimeoutMs:20});await timeout.manager.check();
 await assert.rejects(timeout.manager.upgrade({version:'0.167.1',confirmed:true}),error=>{
  assert.equal(error.outcome,'notExecuted');assert.match(error.message,/暂存安装失败，现有版本未更改/);return true;
 });
 assert.deepEqual(snapshot(timeoutFixture.packageRoot),timeoutFixture.before);
 assert.equal(existsSync(timeoutInstaller.calls[0].prefix),false);assert.deepEqual(leftovers(path.dirname(timeoutFixture.packageRoot)),[]);

 const wrongFixture=filesystemFixture(t);const wrongInstaller=installerHarness();wrongInstaller.set({stageExeVersion:'9.9.9'});
 const wrong=transactionManager(t,wrongFixture,{installer:wrongInstaller});await wrong.manager.check();
 await assert.rejects(wrong.manager.upgrade({version:'0.167.1',confirmed:true}),error=>{
  assert.equal(error.outcome,'notExecuted');assert.match(error.message,/暂存包验证失败/);assert.match(error.message,/现有版本未更改/);return true;
 });
 assert.deepEqual(snapshot(wrongFixture.packageRoot),wrongFixture.before);
});

test('copy failure only removes its own stage paths and keeps the old package unchanged',async t=>{
 const fixture=filesystemFixture(t);const installer=installerHarness();
 const {manager}=transactionManager(t,fixture,{installer,fsOps:{cp:async()=>{throw new Error('disk full');}}});await manager.check();
 await assert.rejects(manager.upgrade({version:'0.167.1',confirmed:true}),error=>{
  assert.equal(error.outcome,'notExecuted');assert.equal(error.code,'RUNTIME_COPY_FAILED');assert.match(error.message,/现有版本未更改/);return true;
 });
 assert.deepEqual(snapshot(fixture.packageRoot),fixture.before);
 assert.equal(existsSync(installer.calls[0].prefix),false);assert.deepEqual(leftovers(path.dirname(fixture.packageRoot)),[]);
});

test('second rename failure rolls back the verified old package and preserves the failed stage',async t=>{
 const fixture=filesystemFixture(t);const installer=installerHarness();let renames=0;
 const fsOps={rename:async(from,to)=>{renames++;if(renames===2)throw new Error('rename denied');return fsRename(from,to);}};
 const {manager}=transactionManager(t,fixture,{installer,fsOps});await manager.check();
 await assert.rejects(manager.upgrade({version:'0.167.1',confirmed:true}),error=>{
  assert.equal(error.outcome,'notExecuted');assert.equal(error.code,'RUNTIME_SWAP_ROLLED_BACK');assert.match(error.message,/已恢复旧版本 0\.157\.1/);return true;
 });
 const failed=leftovers(path.dirname(fixture.packageRoot));
 assert.equal(failed.length,1);assert.match(failed[0],/^\.codex-light-failed-/);
 assert.deepEqual(snapshot(fixture.packageRoot),fixture.before);
 assert.equal(JSON.parse(readFileSync(path.join(path.dirname(fixture.packageRoot),failed[0],'package.json'),'utf8')).version,'0.167.1');
});

test('final new-version probe failure rolls back and preserves the bad new directory',async t=>{
 const fixture=filesystemFixture(t);const installer=installerHarness();let renames=0;
 const fsOps={rename:async(from,to)=>{
  renames++;await fsRename(from,to);
  if(renames===2&&to===fixture.packageRoot)writeFileSync(fixture.npmPath,'codex-cli 9.9.9\n');
 }};
 const {manager}=transactionManager(t,fixture,{installer,fsOps});await manager.check();
 await assert.rejects(manager.upgrade({version:'0.167.1',confirmed:true}),error=>{
  assert.equal(error.outcome,'notExecuted');assert.equal(error.code,'RUNTIME_SWAP_ROLLED_BACK');return true;
 });
 assert.deepEqual(snapshot(fixture.packageRoot),fixture.before);
 const failed=leftovers(path.dirname(fixture.packageRoot));
 assert.equal(failed.length,1);assert.equal(readVersion(path.join(path.dirname(fixture.packageRoot),failed[0],'node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe')),'9.9.9');
});

test('rollback failure is unknown and preserves the backup and failed new directory',async t=>{
 const fixture=filesystemFixture(t);const installer=installerHarness();let renames=0;
 const fsOps={rename:async(from,to)=>{renames++;if(renames===2||renames===4)throw new Error('rename denied');return fsRename(from,to);}};
 const {manager}=transactionManager(t,fixture,{installer,fsOps});await manager.check();
 await assert.rejects(manager.upgrade({version:'0.167.1',confirmed:true}),error=>{
  assert.equal(error.outcome,'unknown');assert.equal(error.code,'RUNTIME_SWAP_ROLLBACK_FAILED');assert.match(error.message,/备份/);return true;
 });
 assert.equal(existsSync(fixture.packageRoot),false);
 const dirs=leftovers(path.dirname(fixture.packageRoot));
 assert.equal(dirs.filter(name=>name.startsWith('.codex-light-backup-')).length,1);
 assert.equal(dirs.filter(name=>name.startsWith('.codex-light-failed-')).length,1);
 const backup=dirs.find(name=>name.startsWith('.codex-light-backup-'));
 assert.deepEqual(snapshot(path.join(path.dirname(fixture.packageRoot),backup)),fixture.before);
 assert.ok(manager.upgradeDiagnostics.some(line=>/回滚失败/.test(line)));
});

test('close during download cancels the stage child, waits, and leaves the old package unchanged',async t=>{
 const fixture=filesystemFixture(t);const installer=installerHarness();installer.set({hang:true});
 const {manager}=transactionManager(t,fixture,{installer,stageTimeoutMs:5000});await manager.check();
 const upgrade=manager.upgrade({version:'0.167.1',confirmed:true});
 for(let index=0;index<50&&!installer.calls.length;index++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.equal(installer.calls.length,1);const prefix=installer.calls[0].prefix;
 const closing=manager.close();
 await assert.rejects(upgrade,error=>{assert.equal(error.outcome,'notExecuted');assert.match(error.message,/取消|暂存安装失败/);return true;});
 await closing;
 assert.deepEqual(snapshot(fixture.packageRoot),fixture.before);
 assert.equal(existsSync(prefix),false);assert.equal(manager.stageRoot,null);assert.deepEqual(leftovers(path.dirname(fixture.packageRoot)),[]);
});

test('close cancellation is bounded when the download child never confirms exit and preserves its stage',async t=>{
 const fixture=filesystemFixture(t);const installer=installerHarness();installer.set({hang:true,killCloses:false});
 const {manager}=transactionManager(t,fixture,{installer,stageTimeoutMs:60000});await manager.check();
 const upgrade=manager.upgrade({version:'0.167.1',confirmed:true});
 for(let index=0;index<50&&!installer.calls.length;index++)await new Promise(resolve=>setTimeout(resolve,2));
 const prefix=installer.calls[0].prefix;const started=Date.now();
 const closing=manager.close();
 await assert.rejects(upgrade,error=>{
  assert.equal(error.outcome,'notExecuted');assert.equal(error.code,'RUNTIME_STAGE_CANCELLED');assert.match(error.message,/未确认退出/);return true;
 });
 await closing;const elapsed=Date.now()-started;
 assert.ok(elapsed>=1800&&elapsed<5000,`bounded cancellation took ${elapsed}ms`);
 assert.deepEqual(snapshot(fixture.packageRoot),fixture.before);
 assert.equal(existsSync(prefix),true,'unconfirmed child requires preserving its own stage');
 assert.equal(manager.stageRoot,null);
 assert.ok(manager.upgradeDiagnostics.some(line=>line.includes(prefix)&&/未确认退出/.test(line)));
 assert.deepEqual(leftovers(path.dirname(fixture.packageRoot)),[]);
 rmSync(prefix,{recursive:true,force:true,maxRetries:3,retryDelay:100});
});

test('close during swap waits for the transaction instead of killing or deleting it',async t=>{
 const fixture=filesystemFixture(t);const installer=installerHarness();let enteredResolve,releaseResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});const gate=new Promise(resolve=>{releaseResolve=resolve;});let renames=0;
 const fsOps={rename:async(from,to)=>{renames++;if(renames===1){enteredResolve();await gate;}return fsRename(from,to);}};
 const {manager}=transactionManager(t,fixture,{installer,fsOps});await manager.check();
 const upgrade=manager.upgrade({version:'0.167.1',confirmed:true});await entered;
 assert.equal(manager.phase,'swap');
 await assert.rejects(manager.upgrade({version:'0.167.1',confirmed:true}),/已有升级/);
 let closed=false;const closing=manager.close().then(()=>{closed=true;});
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(closed,false);
 releaseResolve();const result=await upgrade;await closing;
 assert.deepEqual(result,{outcome:'succeeded',installedVersion:'0.167.1',restartRequired:true});
 assert.equal(JSON.parse(readFileSync(path.join(fixture.packageRoot,'package.json'),'utf8')).version,'0.167.1');
});
