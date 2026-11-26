// Codex plugin inventory, catalog, and explicit install/uninstall confirmations.
import { icon } from './icons.js';
import { switchInput, onAsyncSwitchChange } from './ui/format.js';
import { mountPluginActionsPanel, pluginActionVerb } from './plugin-actions-panel.js';
const UNKNOWN='未知（服务未提供）';
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const string=(value,max=1000)=>typeof value==='string'?value.slice(0,max):'';
const flag=value=>typeof value==='boolean'?value:null;
const absolutePath=value=>typeof value==='string'&&value.length>0&&value.length<=8192&&!/[\u0000\r\n]/.test(value)&&(/^[A-Za-z]:[\\/]/.test(value)||value.startsWith('/')||/^\\\\[^\\]+\\[^\\]+/.test(value));
const names=(rows,key='name',max=100)=>Array.isArray(rows)?rows.slice(0,max).map(row=>string(typeof row==='string'?row:row?.[key],200)).filter(Boolean):[];
const booleanLabel=value=>value===true?'是':value===false?'否':UNKNOWN;
const policyLabel=(value,kind)=>({install:{NOT_AVAILABLE:'目录策略不允许安装',AVAILABLE:'目录策略允许安装（不代表兼容）',INSTALLED_BY_DEFAULT:'默认安装策略'},auth:{ON_INSTALL:'安装时认证',ON_USE:'使用时认证'}}[kind][value]||string(value,100)||UNKNOWN);
export function pluginSourceLabel(source){
 if(!plain(source))return UNKNOWN;
 if(source.type==='local')return '本地 · '+(string(source.path,2000)||UNKNOWN);
 if(source.type==='git'){let url='地址未显示';try{const parsed=new URL(source.url);if(['https:','http:','ssh:','git:'].includes(parsed.protocol))url=parsed.protocol+'//'+parsed.host+parsed.pathname;}catch{}return 'Git · '+url;}
 if(source.type==='npm')return 'npm · '+(string(source.package,512)||UNKNOWN)+(string(source.version,100)?' @ '+string(source.version,100):'');
 return source.type==='remote'?'远程目录':UNKNOWN;
}
export function pluginCompatibility(summary){
 if(summary?.availability==='DISABLED_BY_ADMIN'||summary?.disabledReason==='disabled_by_admin')return {label:'管理员已停用',evidence:'服务返回管理员限制；不表示已测试宿主兼容性。'};
 if(summary?.disabledReason==='plan_not_eligible')return {label:'当前套餐不适用',evidence:'服务返回套餐限制；未修改套餐或权限。'};
 if(summary?.disabledReason==='required_app_unavailable')return {label:'依赖应用当前不可用',evidence:'服务返回依赖应用不可用；不能据此推断是桌面端专用。'};
 return {label:'宿主兼容性未核实',evidence:'已安装、已启用或目录可见均不证明本客户端能使用全部能力。桌面端专用能力与自定义插件界面不能自动复用。'};
}
export function pluginReadParams(row){
 if(!row||typeof row.pluginName!=='string'||!row.pluginName||row.pluginName.length>512)throw new Error('缺少可靠的插件名称。');
 if(row.marketplacePath!==null&&row.marketplacePath!==undefined){if(!absolutePath(row.marketplacePath))throw new Error('插件目录路径无效。');return {marketplacePath:row.marketplacePath,pluginName:row.pluginName};}
 if(typeof row.marketplaceName==='string'&&row.marketplaceName&&row.marketplaceName.length<=512&&typeof row.remotePluginId==='string'&&row.remotePluginId&&row.remotePluginId.length<=512)return {remoteMarketplaceName:row.marketplaceName,pluginName:row.remotePluginId};
 throw new Error('缺少可靠的插件目录来源。');
}
export function pluginListParams(cwd='',includeDefaultRemote=false){
 if(typeof cwd!=='string'||(cwd&&!absolutePath(cwd)))throw new Error('工作目录无效。');
 return { ...(cwd?{cwds:[cwd]}:{}),...(!includeDefaultRemote?{marketplaceKinds:['local']}:{}),forceRefetch:false};
}
export function normalizePluginList(response){
 if(!plain(response)||!Array.isArray(response.marketplaces))throw new Error('插件目录返回格式无效。');
 const rows=[],seen=new Set();let truncated=response.marketplaces.length>50,examined=0;
 for(const market of response.marketplaces.slice(0,50)){
  if(!plain(market)||!Array.isArray(market.plugins))continue;
  const validMarket=typeof market.name==='string'&&market.name.length>0&&market.name.length<=512;
  const validPath=market.path===null||absolutePath(market.path);
  const marketplaceName=validMarket?market.name:'',marketplacePath=typeof market.path==='string'&&validPath?market.path:null;
  for(const summary of market.plugins){
   if(rows.length>=500||examined>=1000){truncated=true;break;}examined++;
   if(!plain(summary)||typeof summary.name!=='string'||!summary.name||summary.name.length>512){truncated=true;continue;}
   const pluginName=string(summary.name,512),id=string(summary.id,1000)||pluginName;
   const key=JSON.stringify([marketplacePath||marketplaceName,id]);if(seen.has(key))continue;seen.add(key);
   const row={key,id,pluginName,remotePluginId:string(summary.remotePluginId,512),marketplaceName,marketplacePath,marketplaceLabel:string(market.interface?.displayName,512)||marketplaceName||UNKNOWN,
    title:string(summary.interface?.displayName,512)||pluginName,description:string(summary.interface?.shortDescription,1500),installed:flag(summary.installed),enabled:flag(summary.enabled),
    version:string(summary.version,200),localVersion:string(summary.localVersion,200),source:pluginSourceLabel(summary.source),compatibility:pluginCompatibility(summary),
    installPolicy:string(summary.installPolicy,100),authPolicy:string(summary.authPolicy,100),capabilities:names(summary.interface?.capabilities)};
   try{row.readParams=validMarket&&validPath?pluginReadParams(row):null;}catch{row.readParams=null;}
   rows.push(row);
  }
 }
 // Do not print raw server errors/config excerpts: they can contain private URLs.
 return {rows,truncated,loadErrorCount:Array.isArray(response.marketplaceLoadErrors)?response.marketplaceLoadErrors.length:0};
}
export function pluginDetailRows(response){
 const p=response?.plugin;if(!plain(p)||!plain(p.summary))throw new Error('插件详情返回格式无效。');
 const s=p.summary,c=pluginCompatibility(s);
 return {title:string(s.interface?.displayName,512)||string(s.name,512)||'插件详情',description:string(p.description,6000)||string(s.interface?.longDescription,6000)||string(s.interface?.shortDescription,1500),rows:[
  ['插件 ID',string(s.id,1000)||UNKNOWN],['目录',string(p.marketplaceName,512)||UNKNOWN],['来源',pluginSourceLabel(s.source)],
  ['已安装',booleanLabel(flag(s.installed))],['已启用',booleanLabel(flag(s.enabled))],['本地版本',string(s.localVersion,200)||UNKNOWN],['目录版本',string(s.version,200)||UNKNOWN],
  ['兼容性',c.label],['判断依据',c.evidence],['安装策略',policyLabel(s.installPolicy,'install')],['认证策略',policyLabel(s.authPolicy,'auth')],
  ['声明能力',names(s.interface?.capabilities).join('、')||'未提供'],['技能',names(p.skills).join('、')||'未列出'],['MCP 服务器',names(p.mcpServers).join('、')||'未列出'],
  ['应用',names(p.apps).join('、')||'未列出'],['应用模板',names(p.appTemplates).join('、')||'未列出'],['钩子事件',names(p.hooks,'eventName').join('、')||'未列出'],
  ['计划任务声明',Array.isArray(p.scheduledTasks)?String(p.scheduledTasks.length)+' 项（此页不运行）':'未提供']
 ]};
}
export function filterPlugins(rows,{query='',installedOnly=false}={}){
 const q=string(query,200).trim().toLocaleLowerCase();return rows.filter(row=>(!installedOnly||row.installed===true)&&(!q||[row.title,row.pluginName,row.marketplaceLabel,row.description].some(v=>v.toLocaleLowerCase().includes(q))));
}
const contextKey=c=>JSON.stringify([c?.cwd||'',c?.serverInstance||'',c?.connected===true]);
const errorLabel=(e,kind)=>e?.code===-32601?`当前 Codex CLI 不支持${kind}接口。`:`无法读取${kind}${Number.isInteger(e?.code)?'（'+e.code+'）':''}。请检查 CLI 连接与版本后重试。`;
export function mountPluginsPanel(container,{rpc,getContext=()=>({connected:false}),api,requestId=()=>crypto.randomUUID()}){
 const doc=container.ownerDocument,make=(tag,cls,text)=>{const node=doc.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
 const button=(label,cls='subtle')=>{const b=make('button',cls,label);b.type='button';return b;};
 const header=make('div','plugins-heading'),headerCopy=make('div','plugins-heading-copy');
 const title=make('h1','','插件'),intro=make('p','settings-subtitle','管理当前 Codex 环境中的插件。');
 const refresh=button('刷新');refresh.prepend(icon(doc,'refresh'));headerCopy.append(title,intro);header.append(headerCopy,refresh);
 const toolbar=make('div','plugins-toolbar'),views=make('div','plugins-views');views.setAttribute('role','group');views.setAttribute('aria-label','插件视图');
 const installed=button('已安装','plugins-view'),catalog=button('插件目录','plugins-view');views.append(installed,catalog);
 const controls=make('div','plugins-controls'),search=make('input');search.type='search';search.maxLength=200;
 const remote=switchInput(doc);const remoteLabel=make('label','plugins-remote');remoteLabel.append(remote,doc.createTextNode('包含远程目录'));
 controls.append(search,remoteLabel);toolbar.append(views,controls);
 const overview=make('div','plugins-overview'),subtitle=make('h2','plugins-overview-title'),note=make('p','plugins-note');overview.append(subtitle,note);
 const status=make('p','plugins-status');status.setAttribute('role','status');
 const notice=make('div','plugins-notice');notice.hidden=true;notice.setAttribute('role','status');
 const list=make('div','plugins-list'),detail=make('section','settings-card plugins-detail');detail.hidden=true;detail.tabIndex=-1;detail.setAttribute('aria-label','插件详情');
 container.replaceChildren(header,toolbar,overview,notice,status,list,detail);
 let view='installed',active=false,disposed=false,generation=0,detailGeneration=0,rows=[],busy=false,page=0,actionPanel=null,loaded=false,detailTrigger=null,detailRow=null;
 const uncertainActions=new Set(),pendingAuth=new Map(),statusRequests=new Set();
 const actionTypes=new Set(['install','uninstall','enable','disable']);
 const advertised=entry=>Array.isArray(entry?.actions)?entry.actions.filter(a=>actionTypes.has(a)):null;
 const actionKey=row=>JSON.stringify([contextKey(getContext()),row.key]);
 function allowed(row,action){
  if(typeof api!=='function'||!row.actionHandle||!row.readParams)return false;
  if(action==='enable'||action==='disable')return row.installed===true&&row.enabled===(action==='disable')&&row.actions?.includes(action)===true;
  if(row.actions&&!row.actions.includes(action))return false;
  return row.installed===(action==='uninstall');
 }
 function canRefreshStatus(row){return typeof api==='function'&&row.installed===true&&row.enabled===null&&row.statusCheck===true&&row.actionHandle&&row.readParams&&!uncertainActions.has(actionKey(row));}
 const valid=(g,key)=>!disposed&&active&&generation===g&&contextKey(getContext())===key&&getContext()?.connected===true;
 function disposeAction(){actionPanel?.destroy();actionPanel=null;}
 function setNotice(text,tone='neutral'){notice.textContent=text;notice.className='plugins-notice is-'+tone;notice.hidden=!text;}
 function badge(label,tone){return make('span','plugins-badge is-'+tone,label);}
 function render(){
  installed.setAttribute('aria-pressed',String(view==='installed'));catalog.setAttribute('aria-pressed',String(view==='catalog'));
  const managing=view==='installed';remoteLabel.hidden=managing;
  search.placeholder=managing?'搜索已安装插件':'搜索插件目录';search.setAttribute('aria-label',search.placeholder);
  const installedRows=rows.filter(row=>row.installed===true);
  installed.textContent='已安装';catalog.textContent='插件目录';
  subtitle.textContent=managing?(loaded?'已安装插件 · '+installedRows.length:'已安装插件'):'插件目录';
  note.textContent=managing?'仅显示当前目录确认已安装的插件。':'默认只查看本地目录。打开远程目录会联网；仅浏览不会安装插件。';
  list.replaceChildren();
  if(!loaded)return;
  const visible=filterPlugins(rows,{query:search.value,installedOnly:managing});
  page=Math.min(page,Math.max(0,Math.ceil(visible.length/30)-1));
  for(const row of visible.slice(page*30,page*30+30)){
   const card=make('article','plugins-item'),mark=make('span','plugins-icon');mark.setAttribute('aria-hidden','true');mark.append(icon(doc,'plug',{size:20}));
   const body=make('div','plugins-item-body'),identity=make('div','plugins-item-identity');
   identity.append(make('h3','',row.title));
   if(row.localVersion||row.version)identity.append(make('span','plugins-version',row.localVersion||row.version));
   body.append(identity,make('p','plugins-item-description',row.description||'暂无简介'),make('small','plugins-source',row.marketplaceLabel));
   const state=make('div','plugins-item-state'),auth=pendingAuth.get(actionKey(row));
   if(row.installed===true){
    state.append(row.enabled===true?badge('已启用','good'):row.enabled===false?badge('已停用','neutral'):badge('启停未知','attention'));
    if(auth?.length){const pending=badge('待授权','attention');pending.setAttribute('title','最近安装返回待授权；后续状态未核实');state.append(pending);}
   }else state.append(row.installed===false?badge('未安装','neutral'):badge('安装状态未知','neutral'));
   if(row.compatibility.label!=='宿主兼容性未核实')state.append(badge(row.compatibility.label,'attention'));
   if(uncertainActions.has(actionKey(row)))state.append(badge('操作结果待核实','attention'));
   const open=button('查看详情','subtle plugins-item-action');open.disabled=!row.readParams;
   open.setAttribute('aria-label','查看详情：'+row.title);open.addEventListener('click',()=>{detailTrigger=open;return read(row);});
   const actions=make('div','plugins-row-actions');
   const quick=row.installed===false?'install':row.installed===true&&row.enabled!==null?(row.enabled?'disable':'enable'):null;
   if(quick&&allowed(row,quick)){
    const act=button(pluginActionVerb(quick),'subtle plugins-quick-action is-'+quick);act.disabled=uncertainActions.has(actionKey(row));
    act.setAttribute('aria-label',pluginActionVerb(quick)+'：'+row.title);
    act.addEventListener('click',()=>{detailTrigger=act;return read(row,quick);});actions.append(act);
   }
   if(canRefreshStatus(row)){
    const verify=button('检查状态','subtle plugins-state-check');verify.disabled=statusRequests.has(actionKey(row));verify.setAttribute('aria-label','检查状态：'+row.title);
    verify.addEventListener('click',()=>checkStatus(row,verify));actions.append(verify);
   }
   actions.append(open);card.append(mark,body,state,actions);list.append(card);
  }
  if(visible.length>30){const pager=make('div','plugins-pager'),previous=button('上一页'),next=button('下一页');previous.disabled=page===0;next.disabled=(page+1)*30>=visible.length;previous.addEventListener('click',()=>{page--;render();});next.addEventListener('click',()=>{page++;render();});pager.append(previous,make('span','',`${page*30+1}–${Math.min((page+1)*30,visible.length)} / ${visible.length}`),next);list.append(pager);}
  if(!visible.length){const empty=make('div','plugins-empty');empty.append(make('strong','',search.value.trim()?'没有匹配的插件':managing?'当前没有读取到已安装插件':'当前目录没有返回插件'));if(managing&&!search.value.trim()){empty.append(make('p','','可在插件目录查看当前环境提供的来源。'));const browse=button('打开插件目录');browse.addEventListener('click',()=>switchView('catalog'));empty.append(browse);}else empty.append(make('p','',search.value.trim()?'尝试使用其他关键词。':'可切换目录来源后刷新。'));list.append(empty);}
 }
 async function checkStatus(row,trigger){
  const g=generation,key=contextKey(getContext()),itemKey=actionKey(row),handle=row.actionHandle;
  if(!canRefreshStatus(row)||!valid(g,key)||!rows.includes(row)||statusRequests.has(itemKey)||statusRequests.size>=4)return;
  statusRequests.add(itemKey);trigger.disabled=true;trigger.textContent='检查中…';
  try{
   const fresh=await api('/api/plugins/status',{handle});
   if(!valid(g,key)||!rows.includes(row)||row.actionHandle!==handle)return;
   if(fresh?.status==='verified'&&fresh.key===row.key&&fresh.installed===true&&typeof fresh.enabled==='boolean'&&typeof fresh.handle==='string'&&fresh.handle&&Array.isArray(fresh.actions)){
    row.actionHandle=fresh.handle;row.enabled=fresh.enabled;row.actions=advertised(fresh);row.statusCheck=false;
    setNotice(row.title+'：引擎已报告'+(row.enabled?'启用':'停用')+'状态。','good');render();
    if(!detail.hidden&&detailRow===row)await read(row);
    else if(doc.activeElement===doc.body)refresh.focus();
   }else setNotice(row.title+'：当前 Codex 没返回明确的启停状态，不能在此切换。','attention');
  }catch{if(valid(g,key)&&rows.includes(row))setNotice(row.title+'：暂时无法核查启停状态，请稍后重试。','attention');}
  finally{statusRequests.delete(itemKey);trigger.disabled=false;trigger.textContent='检查状态';}
 }
 async function refreshList(){
  if(disposed||busy||!active)return false;
  const context=getContext();if(!context?.connected){rows=[];loaded=false;render();detail.hidden=true;status.textContent='尚未连接 Codex CLI。';return false;}
  const g=++generation,key=contextKey(context);detailGeneration++;rows=[];loaded=false;page=0;detail.hidden=true;busy=true;refresh.disabled=true;remote.disabled=true;status.textContent='正在读取插件…';list.setAttribute('aria-busy','true');render();
  try{
   disposeAction();const response=await rpc('plugin/list',pluginListParams(context.cwd||'',view==='catalog'&&remote.checked)),result=normalizePluginList(response);
   const handles=new Map();for(const entry of response?.actionHandles??[])if(typeof entry?.key==='string'&&typeof entry?.handle==='string')handles.set(entry.key,entry);
   if(!valid(g,key))return false;
   for(const row of result.rows){const observed=handles.get(row.key);row.actionHandle=observed?.handle??null;row.actions=advertised(observed);row.statusCheck=observed?.statusCheck===true;if(row.installed===false)pendingAuth.delete(actionKey(row));}
   rows=result.rows;loaded=true;status.textContent=[result.truncated?'已达到显示上限，结果可能不完整。':'',result.loadErrorCount?result.loadErrorCount+' 个目录读取失败，结果可能不完整。':''].filter(Boolean).join(' ');render();return true;
  }catch(e){if(valid(g,key)){rows=[];loaded=false;render();status.textContent=errorLabel(e,'插件目录');}return false;}
  finally{if(generation===g){busy=false;refresh.disabled=false;remote.disabled=false;list.setAttribute('aria-busy','false');}}
 }
 function switchView(next){
  if(view===next)return;view=next;page=0;search.value='';generation++;detailGeneration++;busy=false;detail.hidden=true;loaded=false;rows=[];render();return refreshList();
 }
 function closeDetail(){detailGeneration++;disposeAction();detail.hidden=true;detailRow=null;(detailTrigger?.isConnected===false?refresh:detailTrigger||refresh).focus();detailTrigger=null;}
 function showDetail(...nodes){disposeAction();const close=button('关闭详情','subtle plugins-detail-close');close.addEventListener('click',closeDetail);detail.replaceChildren(close,...nodes);}
 async function read(row,requestedAction=null){
  const g=generation,key=contextKey(getContext()),d=++detailGeneration;if(!valid(g,key)||!rows.includes(row)||!row.readParams)return;
  detail.hidden=false;detailRow=row;showDetail(make('p','','正在读取详情…'));detail.focus();
  try{
   const data=pluginDetailRows(await rpc('plugin/read',{...row.readParams}));if(!valid(g,key)||d!==detailGeneration||!rows.includes(row))return;
   showDetail(make('h2','',data.title));if(data.description)detail.append(make('p','plugins-description',data.description));
   const auth=pendingAuth.get(actionKey(row)),dl=make('dl','plugins-facts');
   const facts=[['授权状态',auth?.length?'安装时报告待授权：'+auth.join('、')+'。此页无法确认之后是否已授权。':'未核实'],...data.rows];
   for(const [label,value] of facts)dl.append(make('dt','',label),make('dd','',value));detail.append(dl);
   if(typeof api==='function'&&row.actionHandle){
    const itemKey=actionKey(row);
    const actionContainer=make('section','plugins-actions'),actions=make('div','plugins-detail-actions'),confirmation=make('div');
    const choices=['enable','disable','install','uninstall'].filter(action=>allowed(row,action)).map(action=>{
     const choose=button(pluginActionVerb(action),'subtle plugins-detail-command is-'+action);choose.disabled=uncertainActions.has(itemKey);
     choose.addEventListener('click',()=>{confirmation.hidden=false;if(!uncertainActions.has(itemKey))actionPanel?.select({handle:row.actionHandle,action});});actions.append(choose);return choose;
    });
    if(uncertainActions.has(itemKey))actionContainer.append(make('p','','此插件有尚未核实的操作结果，禁止重试。请核查已安装状态。'));
    else if(row.installed===true&&!allowed(row,'enable')&&!allowed(row,'disable')){
     actionContainer.append(make('p','plugins-operation-hint',row.enabled===null?(row.statusCheck?'当前 Codex 没返回明确的启停状态，检查后仍未知就不能在此切换。':'当前 Codex 没返回明确的启停状态，也不支持单独检查此插件。'):'当前引擎或插件未提供可在这里执行的启停。'));
     if(canRefreshStatus(row)){const verify=button('检查状态','subtle plugins-state-check');verify.addEventListener('click',()=>checkStatus(row,verify));actions.prepend(verify);}
    }
    else if(!choices.length)actionContainer.append(make('p','plugins-operation-hint','当前未提供可在码舱执行的操作。'));
    const setChoicesDisabled=disabled=>{for(const choice of choices)choice.disabled=disabled;};
    confirmation.hidden=!requestedAction;
    actionContainer.append(actions,confirmation);detail.insertBefore(actionContainer,dl);
    actionPanel=mountPluginActionsPanel(confirmation,{
     plan:(handle,action)=>api('/api/plugins/plan',{handle,action}),
     apply:async params=>{
      if(uncertainActions.has(itemKey))throw new Error('Unresolved plugin action');
      uncertainActions.add(itemKey);setChoicesDisabled(true);
      try{
       const result=await api('/api/plugins/apply',{requestId:requestId(),...params});
       if(['succeeded','not-executed'].includes(result?.outcome))uncertainActions.delete(itemKey);
       if(result?.outcome==='succeeded'&&contextKey(getContext())===key){
        if(result.action==='uninstall')pendingAuth.delete(itemKey);
        else if(result.action==='install'){const apps=names(result.appsNeedingAuth,'name',20);if(apps.length)pendingAuth.set(itemKey,apps);else pendingAuth.delete(itemKey);}
        while(pendingAuth.size>500)pendingAuth.delete(pendingAuth.keys().next().value);
        if(active){
         const verb=pluginActionVerb(result.action),hasPending=result.action==='install'&&pendingAuth.has(itemKey);
         setNotice(`${row.title}：${verb}已返回成功，正在刷新插件列表。`,'good');
         // Refresh read-only in the current view, even if details were closed after submission.
         if(busy){generation++;busy=false;}
         void refreshList().then(ok=>{if(!active||disposed||contextKey(getContext())!==key)return;setNotice(`${row.title}：${verb}已返回成功。`+(ok?(hasPending?'安装时有应用需要授权，后续可在官方 Codex 检查。':'列表已刷新。'):'列表刷新失败，可点「刷新」。'),ok&&!hasPending?'good':'attention');});
        }
       }else if(result?.outcome!=='not-executed'&&active&&contextKey(getContext())===key){
        setNotice(`${row.title}：操作结果未知。请核查官方已安装状态；不会自动重试。`,'attention');render();
       }
       return result;
      }catch(e){if(active&&contextKey(getContext())===key){setNotice(`${row.title}：操作结果未知。请核查官方已安装状态；不会自动重试。`,'attention');render();}throw e;}
     },
     onChanged:()=>{status.textContent='插件信息已变化，请刷新列表并重新查看，不会自动继续操作。';},
     onCancel:()=>{if(requestedAction)closeDetail();else{confirmation.hidden=true;actions.firstElementChild?.focus();}},
     onResult:result=>{setChoicesDisabled(true);if(result?.outcome==='not-executed')setNotice('插件操作未提交，请重新选择插件。','attention');}
    });
    if(requestedAction&&allowed(row,requestedAction)&&!uncertainActions.has(itemKey))await actionPanel.select({handle:row.actionHandle,action:requestedAction});
   }
  }catch(e){if(valid(g,key)&&d===detailGeneration)showDetail(make('p','',errorLabel(e,'插件详情')));}
 }
 refresh.addEventListener('click',()=>refreshList());search.addEventListener('input',()=>{page=0;render();});installed.addEventListener('click',()=>switchView('installed'));catalog.addEventListener('click',()=>switchView('catalog'));onAsyncSwitchChange(remote,refreshList);
 detail.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeDetail();}});
 render();
 return {activate(){if(disposed)return;active=true;return refreshList();},refresh:refreshList,deactivate(){disposeAction();active=false;generation++;detailGeneration++;busy=false;refresh.disabled=false;remote.disabled=false;},reset(){disposeAction();generation++;detailGeneration++;rows=[];loaded=false;busy=false;refresh.disabled=false;remote.disabled=false;detail.hidden=true;pendingAuth.clear();setNotice('');render();status.textContent='连接或工作目录已改变，请刷新目录。';},destroy(){disposeAction();disposed=true;active=false;generation++;detailGeneration++;container.replaceChildren();}};
}
