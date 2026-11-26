export const pluginActionVerb=action=>({install:'安装',uninstall:'卸载',enable:'启用',disable:'停用'}[action]??'操作');
const actionTypes=new Set(['install','uninstall','enable','disable']);
const str=(s,max=8192)=>typeof s==='string'?s.slice(0,max):s===null||s===undefined?'未提供':String(s).slice(0,max);
/** Pure confirmation surface. Callbacks must use the backend's observed-handle service. */
export function mountPluginActionsPanel(container,{plan,apply,onChanged=()=>{},onResult=()=>{},onCancel=()=>{},clock=()=>Date.now()}={}){
 if(typeof plan!=='function'||typeof apply!=='function')throw new TypeError('plan/apply callbacks required');
 const doc=container.ownerDocument;let selection=null,prepared=null,busy=false,submitting=false,disposed=false,generation=0;const uncertain=new Set();
 const el=(tag,value)=>{const node=doc.createElement(tag);if(value!==undefined)node.textContent=value;return node;};
 const title=el('h3','确认插件操作'),status=el('p','请选择一个已观察到的插件。');status.setAttribute('role','status');
 const details=el('div');details.className='plugin-actions-details';const confirm=el('button','确认操作'),cancel=el('button','取消');for(const b of [confirm,cancel])b.type='button';
 confirm.className='plugin-action-confirm';cancel.className='subtle';
 const controls=el('div');controls.className='plugin-actions-controls';controls.append(cancel,confirm);
 container.replaceChildren(title,status,details,controls);container.classList.add('plugin-actions-panel');
 function needsOfficial(plan){return plan?.summary?.action==='install'&&plan.summary.mustShowInstallationInterstitial===true;}
 function disabled(){const blocked=!selection||uncertain.has(selection.handle);confirm.disabled=busy||blocked||!prepared||prepared.expiresAt<=clock()||needsOfficial(prepared);cancel.disabled=submitting;container.setAttribute('aria-busy',String(busy));}
 function showSummary(p){
  const s=p.summary;details.replaceChildren();
  const dl=el('dl');const row=(name,value)=>dl.append(el('dt',name),el('dd',str(value)));
  const toggling=s.action==='enable'||s.action==='disable';
  row('操作',s.action==='install'?'安装并启用':pluginActionVerb(s.action));row('名称',s.name);row('插件 ID',s.id);row('远程 ID',s.remotePluginId);row('目录版本',s.version);row('本地版本',s.localVersion);row('目录',s.marketplacePath||s.marketplaceName);
  row('来源类型',s.source?.type);
  for(const k of ['path','url','refName','sha','package','version','registry','downloadSource','warning'])if(s.source?.[k]!=null)row('来源 '+k,s.source[k]);
  row('来源验证','未验证；展示来源不等于安全或宿主兼容性保证。');row('安装策略',s.installPolicy);row('认证策略',s.authPolicy);row('可用性',s.availability);
  for(const [key,label] of [['skills','技能'],['mcpServers','MCP 服务器'],['hooks','钩子'],['apps','应用'],['appTemplates','应用模板']])row(label,Array.isArray(s[key])?(s[key].length?s[key].map(x=>str(x,512)).join('、'):'无声明'):'未知');
  row('定时任务声明数量',s.scheduledTaskCount);row('强制官方安装提示',s.mustShowInstallationInterstitial===true?'需要，必须在官方客户端处理':s.mustShowInstallationInterstitial===false?'服务未要求':'未知');
  if(toggling){
   const facts=el('dl');const put=(label,value)=>facts.append(el('dt',label),el('dd',str(value)));
   put('插件',s.name);put('操作',pluginActionVerb(s.action));
   put('来源',s.source?.path||s.source?.url||s.source?.package||s.marketplaceName||s.marketplacePath||s.source?.type);
   details.append(facts);
   const effects=el('ul');effects.className='plugin-action-effects';
   for(const message of s.consequences??[])effects.append(el('li',str(message)));
   if(effects.children.length)details.append(effects);
   const technical=el('details');technical.className='plugin-action-technical';
   technical.append(el('summary','高级信息：版本、能力与策略'),dl);
   if(s.refreshNotice)technical.append(el('p',str(s.refreshNotice)));details.append(technical);
  }else{
   details.append(dl);
   for(const message of s.consequences??[])details.append(el('p',str(message)));
   if(s.refreshNotice)details.append(el('p',str(s.refreshNotice)));
  }
  details.append(el('p','确认计划两分钟内有效。执行前会再次检查，变化时必须重新确认。'));
 }
 async function prepareAction(){
  if(busy||!selection||uncertain.has(selection.handle)||disposed)return;
  const current=selection,version=++generation;prepared=null;busy=true;disabled();status.textContent='正在读取插件信息…';
  try{const response=await plan(current.handle,current.action);if(disposed||version!==generation)return;
   if(response?.status==='changed'){status.textContent='插件信息已变化。未执行操作，请重新选择更新后的条目。';details.replaceChildren();selection=null;onChanged(response);}
   else if(response?.status==='ready'&&typeof response.planId==='string'&&Number.isFinite(response.expiresAt)&&response.summary?.action===current.action){prepared=response;showSummary(response);status.textContent=response.summary.mustShowInstallationInterstitial===true&&current.action==='install'?'此插件要求官方安装提示，不能以本页摘要替代，请在官方客户端处理。':'请选择是否继续。';}
   else status.textContent='未取得有效确认计划，未执行操作。';
  }catch{if(!disposed&&version===generation)status.textContent='无法创建计划。插件可能受策略限制、需要官方安装提示或来源已变化；未执行插件操作。';}
  finally{if(!disposed&&version===generation){busy=false;disabled();if(prepared&&!cancel.disabled)cancel.focus();}}
 }
 async function execute(){
  if(disposed||busy||!selection||!prepared||uncertain.has(selection.handle))return;
  if(prepared.expiresAt<=clock()){prepared=null;status.textContent='确认计划已过期，请重新检查。';disabled();return;}
  if(prepared.summary.action==='install'&&prepared.summary.mustShowInstallationInterstitial===true)return;
  const version=++generation,current=selection,p=prepared;prepared=null;busy=true;submitting=true;disabled();status.textContent='正在提交已确认操作，请勿重复提交…';
  try{
   uncertain.add(current.handle);
   const result=await apply({planId:p.planId,confirmed:true});
   if(disposed||version!==generation)return;
   if(result?.outcome==='unknown'){uncertain.add(current.handle);status.textContent='操作结果未知。已禁止重试；请先核查官方已安装状态，不能认定未执行。';}
   else if(result?.outcome==='succeeded'){uncertain.delete(current.handle);status.textContent=current.action==='install'?'安装请求已成功返回；授权与实际可用性仍需分别验证。':current.action==='uninstall'?'卸载请求已成功返回；不代表 OAuth 权限已撤销。':pluginActionVerb(current.action)+'请求已成功返回；正在重新读取当前状态。';selection=null;}
   else if(result?.outcome==='not-executed') {uncertain.delete(current.handle);status.textContent='插件信息已变化。请重新选择插件。';selection=null;}
   else {status.textContent='未取得有效执行结果，禁止重试；请核查实际状态。';}
   if(result?.refresh?.status==='failed')details.append(el('p','已安装列表刷新失败，不能据此推断操作未执行。'));
   onResult(result);if(result?.status==='changed')onChanged(result);
  }catch{if(!disposed&&version===generation){uncertain.add(current.handle);status.textContent='请求结果未知。已禁止重试；需核查实际状态，不会自动再次提交。';onResult({outcome:'unknown'});}}
  finally{if(!disposed&&version===generation){busy=false;submitting=false;disabled();}}
 }
 confirm.addEventListener('click',execute);
 cancel.addEventListener('click',()=>{if(submitting)return;generation++;prepared=null;selection=null;busy=false;details.replaceChildren();status.textContent='已取消，未提交操作。';disabled();onCancel();});
 disabled();
 return {
  select(value){
   if(busy)return;
   if(!value||typeof value.handle!=='string'||!actionTypes.has(value.action))throw new TypeError('Observed handle and action required');
   generation++;selection={handle:value.handle,action:value.action};prepared=null;details.replaceChildren();
   const verb=pluginActionVerb(value.action);title.textContent='确认'+verb+'插件';confirm.textContent='确认'+verb;
   if(uncertain.has(value.handle)){status.textContent='此条目有未核实的操作结果，禁止重试。';disabled();return;}
   return prepareAction();
  },
  reset(){generation++;selection=null;prepared=null;busy=false;submitting=false;details.replaceChildren();status.textContent='已清除当前确认；已经提交的操作不会因此撤销，未知结果仍禁止重试。';disabled();},
  destroy(){generation++;disposed=true;container.replaceChildren();}
 };
}
