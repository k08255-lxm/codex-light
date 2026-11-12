import {randomUUID,createHash} from 'node:crypto';
const text=(s,max=512)=>typeof s==='string'&&s.length>0&&s.length<=max?s:null;
const absolute=s=>text(s,8192)&&!/[\0\r\n]/.test(s)&&(/^[A-Za-z]:[\\/]/.test(s)||s.startsWith('/')||/^\\\\[^\\]+\\[^\\]+/.test(s));
const cleanUrl=value=>{try{const u=new URL(value);if(!['https:','http:','ssh:','git:'].includes(u.protocol))return '未显示的 URL';return `${u.protocol}//${u.host}${u.pathname}`;}catch{return '未知 URL';}};
const stable=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(stable).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
const hash=value=>createHash('sha256').update(stable(value)).digest('hex');
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
 consequences:action==='install'?
 ['安装会启用插件并修改共用 Codex 配置；其他使用同一 CODEX_HOME 的客户端会受影响。','安装可能刷新钩子及 MCP，并可能在后台启动 silent OAuth；不应视为仅下载文件。','来源与宿主兼容性未验证；插件钩子或工具可能运行代码。未知来源须明确阅读风险后批准。']:
 ['卸载会修改共用 Codex 插件配置；可能影响其他客户端与正在进行的工作。','卸载不保证撤销已授予的 OAuth 权限或删除远端账户数据。'],
 refreshNotice:'执行后将调用 plugin/installed 刷新；该读取可能在后台物化已安装 bundle，不是纯静态列表。'
};}
/** All catalog observation is backend-only. Never expose it as a client-supplied JSON endpoint. */
export class PluginActionService{
 constructor({rpc,clock=()=>Date.now()}={}){if(!rpc||typeof rpc.call!=='function')throw new TypeError('rpc.call required');this.rpc=rpc;this.clock=clock;this.handles=new Map();this.plans=new Map();this.generation=0;}
 observeCatalog(params,result){
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
    const bound=structuredClone({read,summary:entry.summary,detail:entry.detail??null,cwds:cwds??[]});
    this.handles.set(handle,bound);output.push({handle,key:JSON.stringify([entry.market.path||entry.market.name,entry.summary.id]),name:text(entry.summary.name),id:text(entry.summary.id),source:sourceDisplay(entry.summary.source)});
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
 replacement(bound,detail){const [fresh]=this.observeCatalog({cwds:bound.cwds},{plugin:detail});return {status:'changed',handle:fresh?.handle??null,notice:'插件来源、版本、策略或声明已变化。请重新查看并创建新确认计划；未执行操作。'};}
 async plan(handle,action){
  if(!['install','uninstall'].includes(action))throw new TypeError('Invalid plugin action');
  const bound=this.handles.get(handle);if(!bound)throw new Error('Unknown observed plugin handle');
  const generation=this.generation,detail=await this.read(bound);
  if(generation!==this.generation)throw new Error('Plugin context changed');
  if(fingerprintSummary(detail.summary)!==fingerprintSummary(bound.summary)||(bound.detail&&hash(detail)!==hash(bound.detail)))return this.replacement(bound,detail);
  assertAllowed(detail.summary,action);
  if(action==='install'&&['skills','hooks','apps','appTemplates','mcpServers'].some(key=>!Array.isArray(detail[key])||detail[key].length>100))throw new Error('Cannot present complete plugin capability declarations; use official client');
  const planId=randomUUID(),expiresAt=this.clock()+120000;
  this.plans.set(planId,{bound,detail,fingerprint:hash(detail),action,expiresAt});
  for(const [id,p]of this.plans)if(p.expiresAt<=this.clock())this.plans.delete(id);
  while(this.plans.size>500)this.plans.delete(this.plans.keys().next().value);
  return {status:'ready',planId,expiresAt,summary:display(detail,action)};
 }
 async apply(input){
  if(!input||Object.keys(input).some(k=>!['planId','confirmed'].includes(k))||input.confirmed!==true)throw new TypeError('Explicit plan confirmation required');
  const plan=this.plans.get(input.planId);if(!plan)throw new Error('Unknown or consumed plan');
  this.plans.delete(input.planId); // Consume before any await: duplicate clicks cannot execute twice.
  if(plan.expiresAt<=this.clock())throw new Error('Plugin plan expired');
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
   output.refresh={status:'succeeded',observations:this.observeCatalog(params,installed),loadErrorCount:Array.isArray(installed?.marketplaceLoadErrors)?installed.marketplaceLoadErrors.length:0};
  }catch{output.refresh={status:'failed',notice:'已安装列表刷新失败；不能据此推断操作未执行。'};}
  return output;
 }
 clear(){this.generation++;this.handles.clear();this.plans.clear();}
}
