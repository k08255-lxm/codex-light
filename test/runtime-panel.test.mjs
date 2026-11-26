import test from 'node:test';import assert from 'node:assert/strict';import {mountRuntimePanel} from '../public/runtime-panel.js';
class El{
 constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.listeners={};this.attributes={};this.textContent='';this.className='';this.value='';this.checked=false;this.disabled=false;this.type='';this.hidden=false;}
 prepend(...nodes){this.children.unshift(...nodes);}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 setAttribute(key,value){this.attributes[key]=String(value);}
 addEventListener(key,fn){this.listeners[key]=fn;}
 focus(){this.ownerDocument.activeElement=this;}
 set innerHTML(_){throw Error('HTML forbidden');}
}
const doc={activeElement:null,createElementNS:(_,tag)=>new El(tag,doc),createElement:tag=>new El(tag,doc),defaultView:{confirm(){return false;}}};
const all=node=>[node,...node.children.flatMap(all)];
const text=node=>all(node).map(child=>child.textContent).join(' ');
const button=(root,label)=>all(root).find(node=>node.tag==='button'&&node.textContent===label);
const click=(root,label)=>{const node=button(root,label);assert.ok(node,`missing button ${label}`);return node.listeners.click();};
const CHECKED='2026-11-11T12:00:00.000Z',NOW=Date.parse(CHECKED),TTL=20*60*1000;
function status(overrides={}){
 return{current:{source:'desktop',path:'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\resources\\codex.exe',version:'0.167.0-alpha.3.2'},npm:{available:true,path:'C:\\Users\\TestUser\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',version:'0.157.1'},desktop:{available:true,path:'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\resources\\codex.exe',version:'0.167.0-alpha.3.2'},latest:{version:'0.167.1',checkedAt:CHECKED},canUpgrade:true,blockedReason:null,upgrading:false,...overrides};
}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function timers(){
 let now=0,id=0;const jobs=new Map();
 return{get now(){return now;},get size(){return jobs.size;},setTimeout(fn,delay){const key=++id;jobs.set(key,{fn,at:now+delay});return key;},clearTimeout(key){jobs.delete(key);},async tick(ms=0){const end=now+ms;for(;;){const next=[...jobs].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;jobs.delete(next[0]);next[1].fn();await flush();}now=end;await flush();}};
}
function setup(overrides={}){
 const root=new El('div',doc),calls=[],time=timers();
 const panel=mountRuntimePanel(root,{clock:()=>NOW+time.now,setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,read:async()=>{calls.push(['read']);return status();},check:async()=>{calls.push(['check']);return status();},upgrade:async input=>{calls.push(['upgrade',input]);return{outcome:'succeeded',installedVersion:input.version,restartRequired:true};},queryPending:async()=>{calls.push(['query']);return{outcome:'unknown'};},onRecovered:value=>calls.push(['recovered',value]),...overrides});
 return{root,panel,calls,time};
}
const callsOf=(calls,name)=>calls.filter(call=>call[0]===name);
const statusText=x=>all(x.root).find(node=>node.className==='runtime-status').textContent;

test('opening the page checks the registry once and shows the installed engines',async()=>{
 const x=setup();x.panel.setActive(true);await flush();assert.deepEqual(x.calls,[['read'],['check']]);
 await x.time.tick(60000);assert.equal(x.calls.length,2);
 await click(x.root,'检查更新');x.panel.setActive(false);x.panel.setActive(true);await flush();
 assert.equal(callsOf(x.calls,'check').length,3);
 assert.match(text(x.root),/已安装 · 2/);assert.match(text(x.root),/有新版本 0\.167\.1/);
 assert.equal(all(x.root).filter(el=>el.className==='engine-row').length,2);
});

test('one click installs the displayed npm version and concurrent clicks dispatch only once',async()=>{
 const flight=deferred();
 const x=setup({upgrade:input=>{x.calls.push(['upgrade',input]);return flight.promise;}});
 await x.panel.refresh();
 const first=click(x.root,'升级');await click(x.root,'升级');
 assert.deepEqual(callsOf(x.calls,'upgrade'),[['upgrade',{version:'0.167.1',confirmed:true}]]);
 flight.resolve({outcome:'succeeded',installedVersion:'0.167.1',restartRequired:true});await first;
 assert.match(statusText(x),/npm CLI 已升级到 0\.167\.1/);assert.equal(button(x.root,'升级').hidden,true);
});

test('expired check cannot install the previously offered version',async()=>{
 const x=setup();await x.panel.refresh();await x.time.tick(TTL+1);await click(x.root,'升级');
 assert.equal(callsOf(x.calls,'upgrade').length,0);
});

test('upgrading polls read every ten seconds after busy finally, pauses, resumes and stops when settled',async()=>{
 let reads=0;const x=setup({read:async()=>{reads++;return status({upgrading:reads<4});}});x.panel.setActive(true);await flush();assert.equal(reads,1);assert.equal(x.time.size,1);
 await x.time.tick(9999);assert.equal(reads,1);await x.time.tick(1);assert.equal(reads,2);assert.equal(x.time.size,1);
 x.panel.setActive(false);await x.time.tick(50000);assert.equal(reads,2);assert.equal(x.time.size,0);
 x.panel.setActive(true);await x.time.tick();assert.equal(reads,3);await x.time.tick(10000);assert.equal(reads,4);assert.equal(x.time.size,0);await x.time.tick(30000);assert.equal(reads,4);
});

test('unknown automatically queries then reads actual version, unlocks and never repeats installation',async()=>{
 let reads=0;const x=setup({read:async()=>{x.calls.push(['read']);reads++;return status({npm:{available:true,version:reads>1?'0.157.1':'0.157.0'}});},upgrade:async input=>{x.calls.push(['upgrade',input]);return{outcome:'unknown'};}});
 x.panel.setActive(true);await flush();await click(x.root,'升级');assert.equal((button(x.root,'升级')?.disabled??true),true);await x.time.tick();
 assert.deepEqual(x.calls.map(row=>row[0]),['read','check','upgrade','query','read','recovered']);assert.match(statusText(x),/当前 npm CLI 为 0\.157\.1/);assert.doesNotMatch(statusText(x),/成功|升级到/);assert.equal((button(x.root,'升级')?.disabled??true),false);
 await x.time.tick(60000);assert.equal(callsOf(x.calls,'upgrade').length,1);assert.equal(x.time.size,0);
});

test('query pending keeps polling even if local version is valid; unknown can recover',async()=>{
 let queries=0;const x=setup({queryPending:async()=>({outcome:++queries===1?'pending':'unknown'})});x.panel.reset({pending:true});x.panel.setActive(true);await x.time.tick();assert.equal((button(x.root,'升级')?.disabled??true),true);assert.equal(callsOf(x.calls,'recovered').length,0);assert.equal(x.time.size,1);
 await x.time.tick(10000);assert.equal(queries,2);assert.equal(callsOf(x.calls,'recovered').length,1);assert.equal((button(x.root,'升级')?.disabled??true),false);
});

test('recovery requires available stable npm and stopped backend, regardless of operation receipt',async()=>{
 const samples=[status({upgrading:true}),status({npm:{available:false,version:'0.167.1'}}),status({npm:{available:true,version:'0.167.1-alpha.1'}}),status({npm:{available:true,version:'0.157.1'}})];
 const x=setup({read:async()=>samples.shift(),queryPending:async()=>({outcome:'succeeded',installedVersion:'0.999.0',restartRequired:true})});x.panel.reset({pending:true});x.panel.setActive(true);
 for(let i=0;i<3;i++){await x.time.tick(i?10000:0);assert.equal((button(x.root,'升级')?.disabled??true),true);assert.equal(callsOf(x.calls,'recovered').length,0);}
 await x.time.tick(10000);assert.match(statusText(x),/当前 npm CLI 为 0\.157\.1/);assert.doesNotMatch(statusText(x),/0\.999\.0|成功/);assert.equal(callsOf(x.calls,'recovered').length,1);assert.equal(x.time.size,0);
});

test('query error still reads actual npm but cannot unlock until a successful retry',async()=>{
 let queries=0,reads=0;const x=setup({queryPending:async()=>{if(++queries<3)throw Error('operation lookup unavailable');return{outcome:'unknown'};},read:async()=>{reads++;return status({npm:{available:true,version:'0.157.1'}});}});x.panel.reset({pending:true});x.panel.setActive(true);
 for(let i=0;i<2;i++){await x.time.tick(i?10000:0);assert.equal(reads,i+1);assert.match(text(x.root),/0\.157\.1/);assert.match(statusText(x),/operation lookup unavailable/);assert.equal((button(x.root,'升级')?.disabled??true),true);assert.equal(callsOf(x.calls,'recovered').length,0);}
 await x.time.tick(10000);assert.equal(reads,3);assert.equal(queries,3);assert.match(statusText(x),/当前 npm CLI 为/);assert.equal(callsOf(x.calls,'recovered').length,1);assert.equal(x.time.size,0);
});

test('read failure during recovery is visible and automatically retries without installing',async()=>{
 let reads=0;const x=setup({read:async()=>{if(++reads===1)throw Error('local probe failed');return status();}});x.panel.reset({pending:true});x.panel.setActive(true);await x.time.tick();assert.match(statusText(x),/local probe failed/);assert.equal(x.time.size,1);await x.time.tick(10000);assert.equal(reads,2);assert.equal(callsOf(x.calls,'recovered').length,1);assert.equal(callsOf(x.calls,'upgrade').length,0);
});

test('unknown remains paused when hidden and resumes without a user acknowledgement',async()=>{
 const x=setup();x.panel.reset({pending:true});await x.time.tick(50000);assert.equal(x.calls.length,0);x.panel.setActive(true);x.panel.setActive(false);await x.time.tick(10000);assert.equal(x.calls.length,0);x.panel.setActive(true);await x.time.tick();assert.deepEqual(x.calls.map(row=>row[0]),['query','read','recovered']);
});

test('reset invalidates late query before it can read, report success or clear the new pending marker',async()=>{
 const old=deferred();let queries=0;const x=setup({queryPending:()=>++queries===1?old.promise:Promise.resolve({outcome:'pending'})});x.panel.reset({pending:true});x.panel.setActive(true);await x.time.tick();assert.equal(queries,1);x.panel.reset({pending:true});old.resolve({outcome:'succeeded',installedVersion:'9.9.9',restartRequired:true});await flush();assert.equal(callsOf(x.calls,'read').length,0);assert.equal(callsOf(x.calls,'recovered').length,0);assert.doesNotMatch(statusText(x),/成功|9\.9\.9/);
 await x.time.tick();assert.equal(queries,2);assert.equal((button(x.root,'升级')?.disabled??true),true);
});

test('reset and destroy ignore late read and failure without overwriting a new generation',async()=>{
 for(const fail of [false,true]){const old=deferred();let reads=0;const x=setup({read:()=>++reads===1?old.promise:Promise.resolve(status({npm:{available:true,version:'0.168.0'}}))});const first=x.panel.refresh();x.panel.reset();await x.panel.refresh();const before=statusText(x);if(fail)old.reject(Error('stale failure'));else old.resolve(status({npm:{available:true,version:'9.9.9'}}));await first;assert.equal(statusText(x),before);assert.doesNotMatch(text(x.root),/9\.9\.9|stale failure/);}
 const old=deferred();const y=setup({read:()=>old.promise});const first=y.panel.refresh();y.panel.destroy();old.resolve(status());await first;assert.equal(y.root.children.length,0);assert.equal(y.time.size,0);
});

test('hide while query is in flight suppresses its result, then resumes polling on re-entry',async()=>{
 const old=deferred();let queries=0;const x=setup({queryPending:()=>++queries===1?old.promise:Promise.resolve({outcome:'unknown'})});x.panel.reset({pending:true});x.panel.setActive(true);await x.time.tick();x.panel.setActive(false);old.resolve({outcome:'succeeded',installedVersion:'9.9.9',restartRequired:true});await flush();assert.equal(callsOf(x.calls,'read').length,0);assert.equal(x.time.size,0);
 x.panel.setActive(true);await x.time.tick();assert.equal(queries,2);assert.equal(callsOf(x.calls,'read').length,1);assert.doesNotMatch(statusText(x),/9\.9\.9/);
});

test('reset cannot stop an in-flight installation or allow duplicate dispatch; stale success never wins',async()=>{
 const flight=deferred();const x=setup({upgrade:input=>{x.calls.push(['upgrade',input]);return flight.promise;}});await x.panel.refresh();const first=click(x.root,'升级');x.panel.reset();await x.panel.refresh();assert.equal((button(x.root,'升级')?.disabled??true),true);await click(x.root,'升级');assert.equal(callsOf(x.calls,'upgrade').length,1);const before=statusText(x);
 flight.resolve({outcome:'succeeded',installedVersion:'0.167.1',restartRequired:true});await first;assert.equal(statusText(x),before);assert.equal((button(x.root,'升级')?.disabled??true),false);assert.equal(x.time.size,0);
});

test('destroy ignores late query and install success and never schedules another timer',async()=>{
 const query=deferred();const x=setup({queryPending:()=>query.promise});x.panel.reset({pending:true});x.panel.setActive(true);await x.time.tick();x.panel.destroy();query.resolve({outcome:'succeeded',installedVersion:'9.9.9',restartRequired:true});await flush();assert.equal(x.root.children.length,0);assert.equal(callsOf(x.calls,'read').length,0);assert.equal(x.time.size,0);
 const install=deferred();const y=setup({upgrade:()=>install.promise});await y.panel.refresh();const first=click(y.root,'升级');y.panel.destroy();install.resolve({outcome:'succeeded',installedVersion:'0.167.1',restartRequired:true});await first;assert.equal(y.root.children.length,0);assert.equal(y.time.size,0);
});

test('not-executed preserves concrete error; incomplete receipts and transport failures never report success',async()=>{
 const a=setup({upgrade:async()=>({outcome:'not-executed',error:{message:'rollback restored previous npm package'}})});await a.panel.refresh();await click(a.root,'升级');assert.match(statusText(a),/rollback restored previous npm package/);assert.doesNotMatch(statusText(a),/成功/);assert.equal(a.time.size,0);
 for(const upgrade of [async()=>({outcome:'succeeded',installedVersion:'0.167.0',restartRequired:true}),async()=>({outcome:'succeeded',installedVersion:'0.167.1',restartRequired:false}),async()=>{throw Error('network detail from install');}]){const x=setup({upgrade});await x.panel.refresh();await click(x.root,'升级');assert.doesNotMatch(statusText(x),/已确认|成功/);assert.equal((button(x.root,'升级')?.disabled??true),true);}
});

test('invalid latest, future check, blocked runtime and upgrading disable upgrade',async()=>{
 for(const change of [{latest:{version:'1.2',checkedAt:CHECKED}},{latest:{version:'0.167.1',checkedAt:new Date(NOW+1).toISOString()}},{blockedReason:'有活动任务，暂不能升级'},{upgrading:true}]){const x=setup({read:async()=>status(change)});await x.panel.refresh();assert.equal((button(x.root,'升级')?.disabled??true),true);}
});

test('read and check errors are bounded, visible, and cannot reuse a stale upgrade permission',async()=>{
 const x=setup({check:async()=>{throw Error('registry detail '+('x'.repeat(600))+'TAIL');}});await x.panel.refresh();await click(x.root,'检查更新');assert.match(statusText(x),/registry detail/);assert.doesNotMatch(statusText(x),/TAIL/);assert.equal((button(x.root,'升级')?.disabled??true),true);
});

test('status and paths use text nodes, not injected markup',async()=>{
 const evil='<img src=x onerror="alert(1)"><script>alert(2)</script>';const x=setup({read:async()=>status({current:{source:evil,path:evil,version:evil},blockedReason:evil})});await x.panel.refresh();assert.ok(text(x.root).includes(evil));assert.equal(all(x.root).some(node=>['img','script'].includes(node.tag)),false);
});


test('re-entry during a paused initial read starts a fresh read once the old request settles',async()=>{
 const old=deferred();let reads=0;const x=setup({read:()=>++reads===1?old.promise:Promise.resolve(status()),check:async()=>status({npm:{available:true,version:'0.168.0'}})});x.panel.setActive(true);x.panel.setActive(false);x.panel.setActive(true);assert.equal(reads,1);old.resolve(status({npm:{available:true,version:'9.9.9'}}));await flush();assert.equal(reads,2);assert.match(text(x.root),/0\.168\.0/);assert.doesNotMatch(text(x.root),/9\.9\.9/);assert.equal(x.time.size,0);
});
