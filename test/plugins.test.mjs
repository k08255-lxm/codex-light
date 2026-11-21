import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePluginList,pluginReadParams,pluginListParams,pluginDetailRows,pluginCompatibility,pluginSourceLabel,filterPlugins,mountPluginsPanel} from '../public/plugins.js';
const summary=(overrides={})=>({id:'demo@local',name:'demo',installed:true,enabled:true,source:{type:'local',path:'C:\\plugins\\demo'},interface:{displayName:'示例',shortDescription:'只读插件'},...overrides});
const catalog=(plugins=[summary()],path='C:\\plugins\\market.json')=>({marketplaces:[{name:'local',path,plugins}],marketplaceLoadErrors:[]});
test('plugin selectors use exact official local/remote fields; never infer plugin names from ids',()=>{
 const local=normalizePluginList(catalog()).rows[0];assert.deepEqual(local.readParams,{marketplacePath:'C:\\plugins\\market.json',pluginName:'demo'});
 const remote=normalizePluginList(catalog([summary({id:'different-id',remotePluginId:'remote-exact-id'})],null)).rows[0];assert.deepEqual(remote.readParams,{remoteMarketplaceName:'local',pluginName:'remote-exact-id'});
 assert.equal(normalizePluginList(catalog([summary({remotePluginId:null})],null)).rows[0].readParams,null);
 assert.throws(()=>pluginReadParams({pluginName:'x',marketplacePath:'../bad',marketplaceName:'not-a-fallback'}));
 assert.equal(normalizePluginList(catalog([summary()], '../invalid')).rows[0].readParams,null);
 assert.equal(normalizePluginList({marketplaces:[{name:'local',plugins:[summary()]}]}).rows[0].readParams,null);
 assert.equal(normalizePluginList(catalog([summary({name:'a'.repeat(513)})])).rows.length,0);
});
test('plugin list defaults to local read-only catalogs and only includes cwd when explicit',()=>{
 assert.deepEqual(pluginListParams(),{marketplaceKinds:['local'],forceRefetch:false});
 assert.deepEqual(pluginListParams('/repo',true),{cwds:['/repo'],forceRefetch:false});
 assert.deepEqual(pluginListParams('C:\\repo'),{cwds:['C:\\repo'],marketplaceKinds:['local'],forceRefetch:false});
 assert.throws(()=>pluginListParams('relative'));assert.throws(()=>pluginListParams('C:\\a\nother'));
});
test('installed/enabled/AVAILABLE and claimed capability names never establish host compatibility',()=>{
 for(const value of [{installed:true,enabled:true,availability:'AVAILABLE',interface:{capabilities:['cli','desktop-only']}},{},{desktopOnly:true}])assert.equal(pluginCompatibility(value).label,'宿主兼容性未核实');
 assert.equal(pluginCompatibility({availability:'DISABLED_BY_ADMIN'}).label,'管理员已停用');
 assert.equal(pluginCompatibility({disabledReason:'required_app_unavailable'}).label,'依赖应用当前不可用');
 assert.equal(pluginCompatibility({disabledReason:'plan_not_eligible'}).label,'当前套餐不适用');
});
test('plugin views project a bounded allowlist and exclude manifest/auth/URLs carrying secrets',()=>{
 const p=summary({manifest:{token:'SECRET'},env:{API_KEY:'SECRET'},source:{type:'git',url:'https://user:SECRET@example.com/repo?token=SECRET#SECRET'}});
 const result=normalizePluginList(catalog([p]));assert.equal(result.rows[0].source,'Git · https://example.com/repo');assert.ok(!JSON.stringify(result).includes('SECRET'));
 const details=pluginDetailRows({plugin:{summary:p,marketplaceName:'local',description:'<script>not executed</script>',skills:[{name:'read'}],mcpServers:['server'],hooks:[{eventName:'PreToolUse',command:'SECRET'}],apps:[],scheduledTasks:[{prompt:'SECRET'}],manifest:'SECRET'}});
 assert.ok(!JSON.stringify(details).includes('SECRET'));assert.equal(details.description,'<script>not executed</script>');assert.ok(details.rows.some(([k,v])=>k==='计划任务声明'&&v==='1 项（此页不运行）'));
 assert.equal(pluginSourceLabel({type:'npm',package:'safe',registry:'https://SECRET@registry.example.com'}),'npm · safe');
});
test('unknown installation booleans remain unknown; filtering does not mutate or infer available runtime',()=>{
 const rows=normalizePluginList(catalog([summary(),summary({id:'other',name:'other',installed:undefined,enabled:null,interface:{displayName:'其他'}})])).rows;
 assert.equal(rows[1].installed,null);assert.equal(rows[1].enabled,null);assert.equal(filterPlugins(rows,{installedOnly:true}).length,1);assert.equal(filterPlugins(rows,{query:'其他'})[0].pluginName,'other');assert.equal(rows.length,2);
});
test('catalog bounds/deduplication and partial load errors are explicit',()=>{
 const many=Array.from({length:800},(_,i)=>summary({id:String(i),name:'p'+i}));const projected=normalizePluginList(catalog(many));assert.equal(projected.rows.length,500);assert.equal(projected.truncated,true);
 const duplicate=normalizePluginList({...catalog([summary(),summary()]),marketplaceLoadErrors:[{message:'SECRET'}]});assert.equal(duplicate.rows.length,1);assert.equal(duplicate.loadErrorCount,1);assert.ok(!JSON.stringify(duplicate).includes('SECRET'));
 assert.throws(()=>normalizePluginList({data:[]}));assert.throws(()=>pluginDetailRows({plugin:null}));
});
class Node {
 constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.listeners={};this.value='';this.checked=false;this.disabled=false;this.ownText='';this.classList={add(){}};}
 set textContent(v){this.ownText=String(v);this.children=[];}get textContent(){return this.ownText+this.children.map(x=>x.textContent).join('');}
 set innerHTML(_){throw new Error('Raw HTML is forbidden');}append(...nodes){this.children.push(...nodes.map(x=>typeof x==='string'?new Text(x,this.ownerDocument):x));}prepend(...nodes){this.children.unshift(...nodes);}insertBefore(node,before){this.children.splice(this.children.indexOf(before),0,node);}replaceChildren(...nodes){this.ownText='';this.children=[];this.append(...nodes);}setAttribute(k,v){this[k]=v;}addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}focus(){this.ownerDocument.activeElement=this;}
 async fire(type,event={}){for(const fn of this.listeners[type]||[])await fn({stopPropagation(){},...event});}
}
class Text extends Node {constructor(value,doc){super('#text',doc);this.ownText=value;}}
const document=()=>{const doc={createElement(tag){return new Node(tag,doc);},createElementNS(_,tag){return new Node(tag,doc);},createTextNode(value){return new Text(value,doc);}};return doc;};
const all=root=>[root,...root.children.flatMap(all)];
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('plugin panel is lazy, reads only explicit list/detail, safely renders strings, and bounds visible rows',async()=>{
 const doc=document(),container=new Node('section',doc),calls=[];const context={connected:true,cwd:'C:\\repo',serverInstance:'one'};
 const api=mountPluginsPanel(container,{getContext:()=>context,rpc:async(method,params)=>{calls.push({method,params});return method==='plugin/list'?catalog(Array.from({length:80},(_,i)=>summary({name:'p'+i,id:'p'+i,interface:{displayName:'<img onerror=bad>'}}))):{plugin:{summary:summary(),marketplaceName:'local',skills:[],mcpServers:[]}};}});
 assert.equal(calls.length,0);await api.activate();assert.equal(calls.length,1);assert.equal(all(container).filter(n=>n.tag==='article').length,30);assert.ok(container.textContent.includes('<img onerror=bad>'));assert.equal(all(container).filter(n=>n.tag==='img').length,0);
 await all(container).find(n=>n.tag==='button'&&n.textContent==='查看详情').fire('click');await tick();assert.equal(calls[1].method,'plugin/read');assert.deepEqual(calls[1].params,{marketplacePath:'C:\\plugins\\market.json',pluginName:'p0'});
 assert.ok(calls.every(c=>['plugin/list','plugin/read'].includes(c.method)));api.destroy();assert.equal(container.children.length,0);
});
test('stale plugin responses cannot overwrite a new connection or disposed panel',async()=>{
 const doc=document(),container=new Node('section',doc);let resolve;const context={connected:true,cwd:'/one',serverInstance:'one'};
 const api=mountPluginsPanel(container,{getContext:()=>context,rpc:()=>new Promise(r=>resolve=r)});const pending=api.activate();context.serverInstance='two';api.reset();resolve(catalog());await pending;assert.equal(all(container).filter(n=>n.tag==='article').length,0);assert.ok(container.textContent.includes('连接或工作目录已改变'));
 const again=api.activate();api.destroy();resolve(catalog());await again;assert.equal(container.children.length,0);
});
test('unsupported detail requests show an explicit safe error and retain dismissal without fallback calls',async()=>{
 const doc=document(),container=new Node('section',doc),calls=[];
 const api=mountPluginsPanel(container,{getContext:()=>({connected:true}),rpc:async method=>{calls.push(method);if(method==='plugin/list')return catalog();throw {code:-32601,message:'SECRET upstream error'};}});
 await api.activate();await all(container).find(n=>n.tag==='button'&&n.textContent==='查看详情').fire('click');await tick();assert.ok(container.textContent.includes('不支持插件详情接口'));assert.ok(!container.textContent.includes('SECRET'));
 await all(container).find(n=>n.tag==='button'&&n.textContent==='关闭详情').fire('click');assert.equal(all(container).find(n=>n.tag==='section'&&n.className==='settings-card plugins-detail').hidden,true);assert.deepEqual(calls,['plugin/list','plugin/read']);
});

test('action handles bind by market key; explicit plan/apply respects unknown outcome across refresh',async()=>{
 const doc=document(),container=new Node('section',doc),calls=[];
 const response={marketplaces:[{name:'a',path:'/a',plugins:[summary()]},{name:'b',path:'/b',plugins:[summary()]}],actionHandles:[{key:JSON.stringify(['/a','demo@local']),handle:'ha'},{key:JSON.stringify(['/b','demo@local']),handle:'hb'}]};
 const context={connected:true,cwd:'/work',serverInstance:'one'};
 const panel=mountPluginsPanel(container,{getContext:()=>context,requestId:()=> 'request-one',rpc:async method=>method==='plugin/list'?response:{plugin:{summary:summary(),marketplaceName:'b',skills:[],mcpServers:[]}},api:async(p,b)=>{calls.push([p,b]);return p.endsWith('/plan')?{status:'ready',planId:'p',expiresAt:Date.now()+120000,summary:{action:'uninstall',source:{type:'local'},consequences:[]}}:{outcome:'unknown'};}});
 await panel.activate();assert.equal(calls.length,0);
 await all(container).filter(n=>n.tag==='button'&&n.textContent==='查看详情')[1].fire('click');await tick();
 await all(container).find(n=>n.tag==='button'&&n.textContent==='卸载').fire('click');await tick();assert.deepEqual(calls[0],['/api/plugins/plan',{handle:'hb',action:'uninstall'}]);
 await all(container).find(n=>n.tag==='button'&&n.textContent==='确认卸载').fire('click');assert.deepEqual(calls[1],['/api/plugins/apply',{requestId:'request-one',planId:'p',confirmed:true}]);assert.match(container.textContent,/结果未知/);
 await panel.refresh();await all(container).filter(n=>n.tag==='button'&&n.textContent==='查看详情')[1].fire('click');await tick();assert.equal(all(container).find(n=>n.tag==='button'&&n.textContent==='卸载').disabled,true);panel.destroy();
});

test('plugin manager starts with local installed entries; catalog and remote are deliberate and scoped',async()=>{
 const doc=document(),container=new Node('section',doc),calls=[];
 const response=catalog([summary(),summary({name:'uninstalled',id:'uninstalled',installed:false,enabled:false,interface:{displayName:'可安装示例'}}),summary({name:'unknown',id:'unknown',installed:null,enabled:null,interface:{displayName:'未知示例'}})]);
 const panel=mountPluginsPanel(container,{getContext:()=>({connected:true,cwd:'/work',serverInstance:'one'}),rpc:async(method,params)=>{calls.push([method,params]);return response;}});
 const find=(tag,label)=>all(container).find(n=>n.tag===tag&&n.textContent===label);
 await panel.activate();
 assert.equal(find('button','已安装')['aria-pressed'],'true');
 assert.equal(all(container).filter(n=>n.tag==='article').length,1);
 assert.ok(find('span','已启用'));assert.ok(!find('h3','可安装示例'));
 assert.deepEqual(calls,[['plugin/list',{cwds:['/work'],marketplaceKinds:['local'],forceRefetch:false}]]);
 await find('button','插件目录').fire('click');
 assert.equal(find('button','插件目录')['aria-pressed'],'true');
 assert.equal(all(container).filter(n=>n.tag==='article').length,3);
 assert.ok(find('span','未安装'));assert.ok(find('span','安装状态未知'));
 const remote=all(container).find(n=>n.className==='plugins-remote').children[0];remote.checked=true;await remote.fire('change');
 assert.deepEqual(calls.at(-1),['plugin/list',{cwds:['/work'],forceRefetch:false}]);
 await find('button','已安装').fire('click');
 assert.deepEqual(calls.at(-1),['plugin/list',{cwds:['/work'],marketplaceKinds:['local'],forceRefetch:false}]);assert.equal(all(container).find(n=>n.className==='plugins-remote').hidden,true);
});

test('a confirmed installation refreshes once and only explicit pending auth survives the refresh',async()=>{
 const doc=document(),container=new Node('section',doc),calls=[],context={connected:true,cwd:'/work',serverInstance:'one'};
 let installed=false;
 const p=()=>summary({installed,enabled:installed});
 const panel=mountPluginsPanel(container,{getContext:()=>context,requestId:()=> 'request-one',
  rpc:async(method,params)=>{calls.push([method,params]);return method==='plugin/list'?{...catalog([p()]),actionHandles:[{key:JSON.stringify(['C:\\plugins\\market.json','demo@local']),handle:'observed'}]}:{plugin:{summary:p(),marketplaceName:'local'}};},
  api:async(path,body)=>{calls.push([path,body]);if(path.endsWith('/plan'))return {status:'ready',planId:'prepared',expiresAt:Date.now()+120000,summary:{action:'install',source:{type:'local'},consequences:[]}};installed=true;return {outcome:'succeeded',action:'install',appsNeedingAuth:['示例应用']};}
 });
 const find=(tag,label)=>all(container).find(n=>n.tag===tag&&n.textContent===label);
 await panel.activate();await find('button','插件目录').fire('click');await find('button','查看详情').fire('click');
 assert.ok(find('dd','未核实'));assert.ok(!find('span','待授权'));
 await find('button','安装').fire('click');await tick();
 await find('button','确认安装').fire('click');await tick();
 assert.deepEqual(calls.slice(-2).map(x=>x[0]),['/api/plugins/apply','plugin/list']);
 assert.equal(calls.filter(([name])=>name==='/api/plugins/apply').length,1);
 assert.ok(find('span','待授权'));assert.match(container.textContent,/安装已返回成功/);
 await find('button','查看详情').fire('click');assert.match(container.textContent,/待授权：示例应用/);
 context.serverInstance='other';panel.reset();await panel.activate();assert.ok(!find('span','待授权'));assert.doesNotMatch(container.textContent,/安装已返回成功/);
});

test('quick enable and disable require advertised per-row capability, approval, and observed refresh',async()=>{
 const doc=document(),container=new Node('section',doc),calls=[],context={connected:true,cwd:'/work',serverInstance:'one'};
 let enabled=false,requested;
 const p=()=>summary({enabled});
 const other=summary({name:'no-toggle',id:'no-toggle',enabled:null,interface:{displayName:'未知状态'}});
 const legacy=summary({name:'legacy',id:'legacy',enabled:true,interface:{displayName:'旧协议'}});
 const response=()=>({...catalog([p(),other,legacy]),actionHandles:[
  {key:JSON.stringify(['C:\\plugins\\market.json','demo@local']),handle:'observed',actions:[enabled?'disable':'enable','uninstall']},
  {key:JSON.stringify(['C:\\plugins\\market.json','no-toggle']),handle:'other',actions:['disable','uninstall']},
  {key:JSON.stringify(['C:\\plugins\\market.json','legacy']),handle:'legacy'}
 ]});
 const panel=mountPluginsPanel(container,{getContext:()=>context,requestId:()=>String(calls.length),
  rpc:async(method,params)=>{calls.push([method,params]);return method==='plugin/list'?response():{plugin:{summary:p(),marketplaceName:'local'}};},
  api:async(path,body)=>{calls.push([path,body]);if(path.endsWith('/plan')){requested=body.action;return {status:'ready',planId:'prepared',expiresAt:Date.now()+120000,summary:{action:requested,source:{type:'local'},consequences:[]}};}enabled=requested==='enable';return {outcome:'succeeded',action:requested};}
 });
 const find=(tag,label)=>all(container).find(n=>n.tag===tag&&n.textContent===label);
 const applyCount=()=>calls.filter(([name])=>name==='/api/plugins/apply').length;
 await panel.activate();
 assert.equal(all(container).filter(n=>n.tag==='button'&&['启用','停用'].includes(n.textContent)).length,1);
 assert.ok(find('span','已停用'));
 await find('button','启用').fire('click');await tick();
 assert.deepEqual(calls.at(-1),['/api/plugins/plan',{handle:'observed',action:'enable'}]);assert.equal(applyCount(),0);assert.ok(find('span','已停用'));
 const confirm=find('button','确认启用');assert.equal(confirm.disabled,false);
 assert.equal(all(container).filter(n=>n.tag==='input'&&n.type==='checkbox').length,1);
 await confirm.fire('click');await tick();
 assert.equal(applyCount(),1);assert.ok(find('button','停用'));assert.doesNotMatch(container.textContent,/有应用需要授权/);
 await find('button','停用').fire('click');await tick();
 assert.deepEqual(calls.at(-1),['/api/plugins/plan',{handle:'observed',action:'disable'}]);assert.equal(applyCount(),1);
 await find('button','取消').fire('click');assert.equal(applyCount(),1);assert.ok(find('button','停用'));
});

test('unknown enabled state can explicitly check matching handle and never guesses a result',async()=>{
 const doc=document(),container=new Node('section',doc),calls=[],context={connected:true,cwd:'/work',serverInstance:'one'};
 const s=summary({enabled:null});
 const key=JSON.stringify(['C:\\plugins\\market.json','demo@local']);
 let observed={status:'unknown'};
 const panel=mountPluginsPanel(container,{getContext:()=>context,
  rpc:async()=>({...catalog([s]),actionHandles:[{key,handle:'obs',actions:['uninstall'],statusCheck:true}]}),
  api:async(path,body)=>{calls.push([path,body]);return observed;}
 });
 const find=(tag,label)=>all(container).find(n=>n.tag===tag&&n.textContent===label);
 await panel.activate();assert.ok(find('span','启停未知'));assert.ok(!find('button','启用'));assert.equal(calls.length,0);
 await find('button','检查状态').fire('click');
 assert.deepEqual(calls,[['/api/plugins/status',{handle:'obs'}]]);assert.ok(find('span','启停未知'));assert.match(container.textContent,/没返回明确/);
 observed={status:'verified',key:'mismatch',handle:'fresh',installed:true,enabled:false,actions:['enable']};
 await find('button','检查状态').fire('click');assert.ok(!find('button','启用'));
 observed={...observed,key};
 await find('button','检查状态').fire('click');assert.ok(!find('span','启停未知'));assert.ok(find('span','已停用'));assert.ok(find('button','启用'));assert.ok(!find('button','检查状态'));
 assert.equal(calls.filter(([path])=>path!=='/api/plugins/status').length,0);
});
