import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {parseCodexVersion} from './runtime-path.mjs';
const text=(s,max=512)=>typeof s==='string'&&s.length>0&&s.length<=max?s:null;
const absolute=s=>text(s,8192)&&!/[\0\r\n]/.test(s)&&(/^[A-Za-z]:[\\/]/.test(s)||s.startsWith('/')||/^\\\\[^\\]+\\[^\\]+/.test(s));
const cleanUrl=value=>{try{const u=new URL(value);if(!['https:','http:','ssh:','git:'].includes(u.protocol))return '未显示的 URL';return `${u.protocol}//${u.host}${u.pathname}`;}catch{return '未知 URL';}};
const stable=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(stable).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
const hash=value=>createHash('sha256').update(stable(value)).digest('hex');
const toggleActions=new Set(['enable','disable']);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const own=(v,k)=>object(v)&&Object.hasOwn(v,k)?v[k]:undefined;
// The 0.157.1 app-server supports quoted TOML key segments and versioned
// config writes. A remote-only catalog's account-managed enablement is not
// equivalent to the local Codex user setting.
function supportsToggle(version){
 const parts=parseCodexVersion(version)?.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
 return !!parts&&parts.every(Number.isSafeInteger)&&(parts[0]>0||parts[1]>157||(parts[1]===157&&parts[2]>=1));
}
function toggleId(market,summary){
 const plugin=text(summary?.name,200),directory=text(market?.name,200);
 if(!absolute(market?.path)||!plugin||!directory||!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(plugin)||!/^[A-Za-z0-9_-]+$/.test(directory))return null;
 const id=plugin+'@'+directory;
 return summary.id===id&&['local','git','npm'].includes(summary.source?.type)&&!summary.remotePluginId&&!summary.shareContext?id:null;
}
function assertToggle(market,s,action){
 const id=toggleId(market,s),enabled=action==='enable';
 if(!id||s.installed!==true||s.enabled!==!enabled||s.availability!=='AVAILABLE'||s.disabledReason||!['AVAILABLE','INSTALLED_BY_DEFAULT'].includes(s.installPolicy)||enabled&&s.mustShowInstallationInterstitial===true)throw new Error('当前插件无法在码舱切换状态；请核对已安装状态、来源及管理策略。');
 return id;
}
function actionsFor(market,s,allowToggle){
 const actions=s.installed===true?['uninstall']:[];
 if(s.installed===false)try{assertAllowed(s,'install');actions.push('install');}catch{}
 if(allowToggle&&typeof s.enabled==='boolean'){const action=s.enabled?'disable':'enable';try{assertToggle(market,s,action);actions.unshift(action);}catch{}}
 return actions;
}
function toggleConfigProjection(read,id){
 if(!object(read?.config)||!Array.isArray(read.layers)||!object(read.origins))throw new Error('当前引擎未提供可核对的用户配置。');
 const active=read.layers.find(layer=>layer?.name?.type==='user');
 if(!active||active.disabledReason!=null||active.name.profile!=null||!absolute(active.name.file)||!text(active.version)||!object(active.config))throw new Error('当前用户配置层不可写或已有独立配置档。');
 const flags=layers=>{
  const plugins=own(layers,'plugins'),entry=own(plugins,id);
  if(plugins!==undefined&&!object(plugins)||entry!==undefined&&!object(entry))throw new Error('插件配置结构无法核实。');
  const enabled=own(entry,'enabled');
  if(enabled!==undefined&&typeof enabled!=='boolean')throw new Error('插件启用状态无法核实。');
  return enabled??null;
 };
 const enabled=flags(read.config),userEnabled=flags(active.config);
 const origin=read.origins['plugins.'+id+'.enabled']?.name?.type;
 if(origin&&origin!=='user'&&origin!=='packagedDefaults')throw new Error('插件状态受其他配置层控制。');
 if(own(own(read.config,'features'),'plugins')===false)throw new Error('当前配置已关闭插件能力。');
 for(const layer of read.layers){
  if(layer===active||layer?.disabledReason!=null)continue;
  if(!text(layer?.name?.type)||!object(layer.config))throw new Error('无法核对全部生效配置层。');
  if(layer.name.type!=='packagedDefaults'&&flags(layer.config)!==null)throw new Error('插件状态受其他配置层控制。');
 }
 return {file:active.name.file,version:active.version,enabled,userEnabled};
}
const summaryKeys=['id','remotePluginId','name','source','version','localVersion','installed','enabled','installPolicy','authPolicy','availability','disabledReason','mustShowInstallationInterstitial','extensions','shareContext'];
const fingerprintSummary=s=>hash(Object.fromEntries(summaryKeys.map(k=>[k,s?.[k]??null])));
const list=(items,key='name')=>Array.isArray(items)?items.slice(0,100).map(x=>text(typeof x==='string'?x:x?.[key])??'未知').filter(Boolean):null;
function sourceDisplay(source){
 const type=text(source?.type,100)??'unknown';
 if(type==='local')return {type,path:text(source.path,8192),unverified:true};
 if(type==='git')return {type,url:cleanUrl(source.url),path:text(source.path),refName:text(source.refName),sha:text(source.sha),unverified:true};
 if(type==='npm')return {type,package:text(source.package),version:text(source.version),registry:source.registry?cleanUrl(source.registry):'默认 npm 配置（未经验证）',unverified:true};
 if(type==='remote')return {type,downloadSource:'服务端保管，客户端未核实下载源',unverified:true};
 return {type,unverified:true,warning:'未知来源类型，无法确认安装内容与行为；必须展示此风险再请求明确批准。'};
}
function selector(market,s){
 if(market.path!==null&&market.path!==undefined){if(!absolute(market.path)||!text(s.name))throw new Error('Invalid observed local selector');return {marketplacePath:market.path,pluginName:s.name};}
 if(!text(market.name)||!text(s.remotePluginId))throw new Error('Missing observed remote plugin identifier');
 return {remoteMarketplaceName:market.name,pluginName:s.remotePluginId};
}
function assertAllowed(summary,action){
 if(action==='uninstall'){if(summary.installed!==true)throw new Error('Plugin is not confirmed installed');return;}
 if(summary.installPolicy==='NOT_AVAILABLE'||summary.availability==='DISABLED_BY_ADMIN'||summary.disabledReason)throw new Error('Plugin unavailable under current policy');
 if(!['AVAILABLE','INSTALLED_BY_DEFAULT'].includes(summary.installPolicy)||summary.availability!=='AVAILABLE')throw new Error('Plugin policy is unknown');
 if(action==='install'&&summary.mustShowInstallationInterstitial===true)throw new Error('Official installation interstitial required; complete this installation in the official client');
 if(action==='uninstall'&&summary.installed!==true)throw new Error('Plugin is not confirmed installed');
}
function display(detail,action){const s=detail.summary;return {
 action,name:text(s.name),id:text(s.id),remotePluginId:text(s.remotePluginId),version:text(s.version),localVersion:text(s.localVersion),
 source:sourceDisplay(s.source),installed:s.installed===true,enabled:s.enabled===true,availability:s.availability,installPolicy:s.installPolicy,authPolicy:s.authPolicy,
 marketplaceName:text(detail.marketplaceName),marketplacePath:text(detail.marketplacePath,8192),
 mustShowInstallationInterstitial:s.mustShowInstallationInterstitial??null,
 skills:list(detail.skills),mcpServers:list(detail.mcpServers),hooks:list(detail.hooks,'eventName'),apps:list(detail.apps),appTemplates:list(detail.appTemplates),
 scheduledTaskCount:Array.isArray(detail.scheduledTasks)?detail.scheduledTasks.length:null,
 requiresExplicitConfirmation:true,sourceVerified:false,
 consequences:toggleActions.has(action)?[
 `仅修改共用 Codex 用户配置中的这一项：${action==='enable'?'启用':'停用'}「${text(s.interface?.displayName)??text(s.name)}」。其他使用同一配置的客户端也可能受影响。`,
 '不会安装、卸载或撤销授权，不会热重载已打开的会话。请在新会话查验运行中的能力。',
 ...(action==='enable'?['启用后，插件提供的钩子、应用或工具可能在后续会话运行；来源与宿主兼容性未核实。']:[])
 ]:action==='install'?
 ['安装会启用插件并修改共用 Codex 配置；其他使用同一 CODEX_HOME 的客户端会受影响。','安装可能刷新钩子及 MCP，并可能在后台启动 silent OAuth；不应视为仅下载文件。','来源与宿主兼容性未验证；插件钩子或工具可能运行代码。未知来源须明确阅读风险后批准。']:
 ['卸载会修改共用 Codex 插件配置；可能影响其他客户端与正在进行的工作。','卸载不保证撤销已授予的 OAuth 权限或删除远端账户数据。'],
 refreshNotice:toggleActions.has(action)?'操作后会重新读取配置和插件状态；无法核实时不会重试。':'执行后将调用 plugin/installed 刷新；该读取可能在后台物化已安装 bundle，不是纯静态列表。'
};}
/** All catalog observation is backend-only. Never expose it as a client-supplied JSON endpoint. */
export class PluginActionService{
 constructor({rpc,clock=()=>Date.now()}={}){if(!rpc||typeof rpc.call!=='function')throw new TypeError('rpc.call required');this.rpc=rpc;this.clock=clock;this.handles=new Map();this.plans=new Map();this.generation=0;}
 observeCatalog(params,result,{allowToggle=true}={}){
  const cwds=params?.cwds;
  if(cwds!==undefined&&(!Array.isArray(cwds)||cwds.length>1||cwds.some(p=>!absolute(p))))throw new Error('Invalid observed cwd');
  const observations=[];
  if(result?.plugin?.summary){const p=result.plugin;observations.push({market:{name:p.marketplaceName,path:p.marketplacePath},summary:p.summary,detail:p});}
  else if(Array.isArray(result?.marketplaces)){for(const market of result.marketplaces.slice(0,50))for(const summary of (Array.isArray(market.plugins)?market.plugins:[]).slice(0,500))observations.push({market,summary});}
  else throw new Error('Invalid observed plugin response');
  const output=[];
  for(const entry of observations.slice(0,500)){
   try{
    if(!text(entry.summary?.id))continue;
    const read=selector(entry.market,entry.summary),handle=randomUUID();
    // Own immutable copies: later mutation of a caller's catalog object cannot alter approval scope.
    const canToggle=allowToggle&&supportsToggle(this.rpc.version);
    const actions=actionsFor(entry.market,entry.summary,canToggle);
    const statusCheck=canToggle&&entry.summary.installed===true&&typeof entry.summary.enabled!=='boolean'&&!!toggleId(entry.market,entry.summary);
    const market=structuredClone({path:entry.market.path,name:entry.market.name});
    const bound=structuredClone({read,market,summary:entry.summary,detail:entry.detail??null,cwds:cwds??[],actions,allowToggle,statusCheck});
    this.handles.set(handle,bound);output.push({handle,key:JSON.stringify([entry.market.path||entry.market.name,entry.summary.id]),name:text(entry.summary.name),id:text(entry.summary.id),source:sourceDisplay(entry.summary.source),actions,statusCheck});
   }catch{/* Missing observed directory/ID: no mutation handle. */}
  }
  while(this.handles.size>1000)this.handles.delete(this.handles.keys().next().value);
  return output;
 }
 async read(bound){
  const response=await this.rpc.call('plugin/read',structuredClone(bound.read)),detail=response?.plugin;
  if(!detail?.summary)throw new Error('Invalid plugin details');
  const current=selector({name:detail.marketplaceName,path:detail.marketplacePath},detail.summary);
  if(stable(current)!==stable(bound.read)||detail.summary.id!==bound.summary.id)throw new Error('Plugin identity or directory changed');
  return structuredClone(detail);
 }
 async checkStatus(handle,{allowToggle=true}={}){
  const unknown={status:'unknown'};
  const bound=this.handles.get(handle);
  if(!allowToggle||!bound?.statusCheck||!supportsToggle(this.rpc.version))return unknown;
  const generation=this.generation;
  try{
   const detail=await this.read(bound),summary=detail.summary;
   if(generation!==this.generation||this.handles.get(handle)!==bound||!supportsToggle(this.rpc.version))return unknown;
   const market={name:detail.marketplaceName,path:detail.marketplacePath};
   const id=toggleId(market,summary);
   if(!id||id!==toggleId(bound.market,bound.summary)||stable(summary.source)!==stable(bound.summary.source)||summary.installed!==true||typeof summary.enabled!=='boolean')return unknown;
   const [observed]=this.observeCatalog({cwds:bound.cwds},{plugin:detail},{allowToggle:true});
   if(!observed)return unknown;
   return {status:'verified',key:observed.key,handle:observed.handle,actions:observed.actions,installed:true,enabled:summary.enabled};
  }catch{return unknown;}
 }
 replacement(bound,detail){const [fresh]=this.observeCatalog({cwds:bound.cwds},{plugin:detail},{allowToggle:bound.allowToggle});return {status:'changed',handle:fresh?.handle??null,notice:'插件来源、版本、策略或声明已变化。请重新查看并创建新确认计划；未执行操作。'};}
 async readToggleConfig(bound,id){
  const market=bound.read.marketplacePath;
  const parent=(market.startsWith('/')?path.posix:path.win32).dirname(market);
  const directories=[...new Set([parent,...bound.cwds])];
  const [requirementsRead,...reads]=await Promise.all([this.rpc.call('configRequirements/read',{}),this.rpc.call('config/read',{includeLayers:true}),...directories.map(cwd=>this.rpc.call('config/read',{includeLayers:true,cwd}))]);
  if(!object(requirementsRead)||!Object.hasOwn(requirementsRead,'requirements')||requirementsRead.requirements!==null&&!object(requirementsRead.requirements))throw new Error('无法核对当前 Codex 管理约束。');
  const requirements=requirementsRead.requirements;
  if(own(own(requirements,'featureRequirements'),'plugins')===false||own(own(requirements,'plugins'),id)!==undefined)throw new Error('插件受 Codex 管理约束。');
  const [user,...scoped]=reads.map(read=>toggleConfigProjection(read,id));
  if(scoped.some(row=>stable(row)!==stable(user)))throw new Error('工作目录与用户配置中的插件状态不一致。');
  return {...user,requirementsFingerprint:hash(requirements)};
 }
 async plan(handle,action,{allowToggle=true}={}){
  if(!['install','uninstall','enable','disable'].includes(action))throw new TypeError('Invalid plugin action');
  const bound=this.handles.get(handle);if(!bound)throw new Error('Unknown observed plugin handle');
  const toggle=toggleActions.has(action);
  if(toggle&&(!allowToggle||!bound.actions.includes(action)||!supportsToggle(this.rpc.version)))throw new Error('插件启停仅限本机兼容的已安装插件。');
  const generation=this.generation,detail=await this.read(bound);
  if(generation!==this.generation)throw new Error('Plugin context changed');
  if(fingerprintSummary(detail.summary)!==fingerprintSummary(bound.summary)||(bound.detail&&hash(detail)!==hash(bound.detail)))return this.replacement(bound,detail);
  let activation=null;
  if(toggle){
   const id=assertToggle({name:detail.marketplaceName,path:detail.marketplacePath},detail.summary,action);
   activation={id,config:await this.readToggleConfig(bound,id)};
   if(generation!==this.generation)throw new Error('Plugin context changed');
   if(activation.config.enabled!==null&&activation.config.enabled!==detail.summary.enabled)throw new Error('插件与配置返回的状态不一致，请刷新后重试。');
  }else assertAllowed(detail.summary,action);
  if(action==='install'&&['skills','hooks','apps','appTemplates','mcpServers'].some(key=>!Array.isArray(detail[key])||detail[key].length>100))throw new Error('Cannot present complete plugin capability declarations; use official client');
  const planId=randomUUID(),expiresAt=this.clock()+120000;
  this.plans.set(planId,{bound,detail,fingerprint:hash(detail),action,expiresAt,activation});
  for(const [id,p]of this.plans)if(p.expiresAt<=this.clock())this.plans.delete(id);
  while(this.plans.size>500)this.plans.delete(this.plans.keys().next().value);
  return {status:'ready',planId,expiresAt,summary:display(detail,action)};
 }
 async apply(input,{allowToggle=true}={}){
  if(!input||Object.keys(input).some(k=>!['planId','confirmed'].includes(k))||input.confirmed!==true)throw new TypeError('Explicit plan confirmation required');
  const plan=this.plans.get(input.planId);if(!plan)throw new Error('Unknown or consumed plan');
  if(plan.activation&&!allowToggle)throw new Error('插件启停仅限本机。');
  this.plans.delete(input.planId); // Consume before any await: duplicate clicks cannot execute twice.
  if(plan.expiresAt<=this.clock())throw new Error('Plugin plan expired');
  if(plan.activation)return this.applyToggle(plan);
  let output,attempted=false;const generation=this.generation;
  try{
   const detail=await this.read(plan.bound);
   if(generation!==this.generation)throw new Error('Plugin context changed');
   if(hash(detail)!==plan.fingerprint){output=this.replacement(plan.bound,detail);output.outcome='not-executed';}
   else{
    assertAllowed(detail.summary,plan.action);
    const method=plan.action==='install'?'plugin/install':'plugin/uninstall';
    const params=plan.action==='install'?{...plan.bound.read,installAttemptId:randomUUID()}:{pluginId:plan.bound.read.remoteMarketplaceName?detail.summary.remotePluginId:detail.summary.id};
    attempted=true;
    const response=await this.rpc.call(method,params);
    if(plan.action==='install'&&(!['ON_INSTALL','ON_USE'].includes(response?.authPolicy)||!Array.isArray(response?.appsNeedingAuth)))throw new Error('Invalid install response');
    output={outcome:'succeeded',action:plan.action,authPolicy:plan.action==='install'?response?.authPolicy??null:null,appsNeedingAuth:plan.action==='install'?list(response?.appsNeedingAuth):null,
     notice:plan.action==='install'?'安装请求已成功返回；授权完成状态与宿主可用性仍须分别验证。':'卸载请求已成功返回；不能据此认为 OAuth 已撤销。'};
   }
  }catch{output={outcome:attempted?'unknown':'not-executed',action:plan.action,notice:attempted?'操作结果未知。未自动重试；必须先核查实际状态，不能认定没有执行。':'执行前检查失败，未提交安装或卸载；计划已消费。'};}
  if(generation!==this.generation){output.refresh={status:'skipped',notice:'连接上下文已改变，未向新连接发起刷新。'};return output;}
  try{
   const params=plan.bound.cwds.length?{cwds:plan.bound.cwds}:{};
   const installed=await this.rpc.call('plugin/installed',params);
   output.refresh={status:'succeeded',observations:this.observeCatalog(params,installed,{allowToggle:plan.bound.allowToggle}),loadErrorCount:Array.isArray(installed?.marketplaceLoadErrors)?installed.marketplaceLoadErrors.length:0};
  }catch{output.refresh={status:'failed',notice:'已安装列表刷新失败；不能据此推断操作未执行。'};}
  return output;
 }
 async applyToggle(plan){
  const {bound,action,activation:{id,config}}=plan,enabled=action==='enable';
  const generation=this.generation;
  const notExecuted={outcome:'not-executed',action,notice:'执行前未能核实配置、插件或连接未变化，未提交启停操作。请刷新后重新确认。'};
  const unknown={outcome:'unknown',action,notice:'无法核实启停结果，不会重试。请刷新并核对 Codex 的实际状态。'};
  let attempted=false;
  try{
   if(!supportsToggle(this.rpc.version))return notExecuted;
   const detail=await this.read(bound);
   if(generation!==this.generation||hash(detail)!==plan.fingerprint)return notExecuted;
   if(assertToggle({name:detail.marketplaceName,path:detail.marketplacePath},detail.summary,action)!==id)return notExecuted;
   const fresh=await this.readToggleConfig(bound,id);
   if(generation!==this.generation||this.clock()>=plan.expiresAt||stable(fresh)!==stable(config))return notExecuted;
   attempted=true;
   // Never accept a client-supplied key, path, boolean or config version.
   const response=await this.rpc.call('config/batchWrite',{edits:[{keyPath:`plugins."${id}".enabled`,value:enabled,mergeStrategy:'replace'}],expectedVersion:fresh.version,reloadUserConfig:false});
   if(generation!==this.generation||response?.status!=='ok'||!text(response?.version))return unknown;
   const [after,plugin]=await Promise.all([this.readToggleConfig(bound,id),this.read(bound)]);
   if(generation!==this.generation||after.file!==fresh.file||after.version!==response.version||after.userEnabled!==enabled||after.enabled!==enabled||plugin.summary.enabled!==enabled||plugin.summary.installed!==true||toggleId({name:plugin.marketplaceName,path:plugin.marketplacePath},plugin.summary)!==id)return unknown;
   return {outcome:'succeeded',action,enabled,notice:'已核对配置和插件状态；已打开的会话未热重载。'};
  }catch{return attempted?unknown:notExecuted;}
 }
 clear(){this.generation++;this.handles.clear();this.plans.clear();}
}
