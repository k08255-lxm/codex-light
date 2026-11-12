// Read-only views of Codex 0.157.1 plugin/list and plugin/read.
// No install, uninstall, configuration writes, OAuth, or inference is performed here.
import { icon } from './icons.js';
import { mountPluginActionsPanel } from './plugin-actions-panel.js';
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
 const header=make('div','plugins-heading'),title=make('h1','','插件'),refresh=make('button','subtle','刷新目录');refresh.type='button';refresh.prepend(icon(doc,'refresh'));
 header.append(title,refresh);const intro=make('p','settings-subtitle',typeof api==='function'?'沿用本机 Codex 配置。安装或卸载需先核对来源与影响，再单独确认；查看目录不会自动安装。':'沿用本机 Codex 的配置，只读查看插件目录与详情。不会安装、移除或授权插件。');
 const controls=make('div','plugins-controls'),search=make('input');search.type='search';search.placeholder='搜索已读取的插件';search.maxLength=200;search.setAttribute('aria-label','搜索已读取的插件');
 const installed=make('input');installed.type='checkbox';const installedLabel=make('label');installedLabel.append(installed,doc.createTextNode('只看已安装'));
 const remote=make('input');remote.type='checkbox';const remoteLabel=make('label');remoteLabel.append(remote,doc.createTextNode('包含默认远程目录（可能联网）'));
 controls.append(search,installedLabel,remoteLabel);const status=make('p','plugins-status','尚未读取目录。');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const note=make('p','plugins-note','数据可能缓存，目录可见不等于运行就绪；仅显示当前查询返回的条目，不保证涵盖全部已安装插件。'),list=make('div','plugins-list'),detail=make('section','settings-card plugins-detail');detail.hidden=true;detail.tabIndex=-1;detail.setAttribute('aria-label','插件详情');
 container.replaceChildren(header,intro,controls,status,note,list,detail);
 let active=false,disposed=false,generation=0,detailGeneration=0,rows=[],busy=false,page=0,actionPanel=null;
 const uncertainActions=new Set();
 function disposeAction(){actionPanel?.destroy();actionPanel=null;}
 const valid=(g,key)=>!disposed&&active&&generation===g&&contextKey(getContext())===key&&getContext()?.connected===true;
 function render(){list.replaceChildren();const visible=filterPlugins(rows,{query:search.value,installedOnly:installed.checked});
  page=Math.min(page,Math.max(0,Math.ceil(visible.length/30)-1));
  for(const row of visible.slice(page*30,page*30+30)){const card=make('article','plugins-item'),mark=make('span','plugins-icon');mark.append(icon(doc,'plug',{size:24}));const body=make('div','plugins-item-body');body.append(make('h2','',row.title),make('p','',row.description||'暂无简介'),make('small','',`${row.marketplaceLabel} · ${row.installed===true?'已安装':row.installed===false?'未安装':'安装状态未知'} · ${row.enabled===true?'已启用':row.enabled===false?'未启用':'启用状态未知'}`),make('small','plugins-compatibility',row.compatibility.label));
   const button=make('button','subtle','查看详情');button.type='button';button.disabled=!row.readParams;button.addEventListener('click',()=>read(row));card.append(mark,body,button);list.append(card);
  }
  if(visible.length>30){const pager=make('div','plugins-pager'),previous=make('button','subtle','上一页'),next=make('button','subtle','下一页');previous.type=next.type='button';previous.disabled=page===0;next.disabled=(page+1)*30>=visible.length;previous.addEventListener('click',()=>{page--;render();});next.addEventListener('click',()=>{page++;render();});pager.append(previous,make('span','',`${page*30+1}–${Math.min((page+1)*30,visible.length)} / ${visible.length}`),next);list.append(pager);}
  if(!visible.length)list.append(make('p','muted',rows.length?'没有匹配的插件。':'当前范围未返回插件。可切换目录范围后刷新；这不证明其他范围未安装插件。'));
 }
 async function refreshList(){if(disposed||busy||!active)return;const context=getContext();if(!context?.connected){rows=[];list.replaceChildren();detail.hidden=true;status.textContent='尚未连接 Codex CLI。';return;}
  const g=++generation,key=contextKey(context);detailGeneration++;rows=[];page=0;list.replaceChildren();detail.hidden=true;busy=true;refresh.disabled=true;remote.disabled=true;status.textContent='正在读取插件目录…';
  try{disposeAction();const response=await rpc('plugin/list',pluginListParams(context.cwd||'',remote.checked)),result=normalizePluginList(response);
   const handles=new Map();for(const entry of response?.actionHandles??[])if(typeof entry?.key==='string'&&typeof entry?.handle==='string')handles.set(entry.key,entry.handle);for(const row of result.rows)row.actionHandle=handles.get(row.key)??null;if(!valid(g,key))return;rows=result.rows;render();status.textContent=`已读取 ${rows.length} 个目录条目${result.truncated?'（已达到显示上限，结果不完整）':''}${result.loadErrorCount?'；'+result.loadErrorCount+' 个目录加载失败，结果可能不完整':''}。`;
  }catch(e){if(valid(g,key)){rows=[];list.replaceChildren();status.textContent=errorLabel(e,'插件目录');}}
  finally{if(generation===g){busy=false;refresh.disabled=false;remote.disabled=false;}}
 }
 function showDetail(...nodes){disposeAction();const close=make('button','subtle','关闭详情');close.type='button';close.addEventListener('click',()=>{detailGeneration++;disposeAction();detail.hidden=true;refresh.focus();});detail.replaceChildren(close,...nodes);}
 async function read(row){const g=generation,key=contextKey(getContext()),d=++detailGeneration;if(!valid(g,key)||!rows.includes(row)||!row.readParams)return;detail.hidden=false;showDetail(make('p','','正在读取详情…'));detail.focus();
  try{const data=pluginDetailRows(await rpc('plugin/read',{...row.readParams}));if(!valid(g,key)||d!==detailGeneration||!rows.includes(row))return;showDetail(make('h2','',data.title));if(data.description)detail.append(make('p','plugins-description',data.description));const dl=make('dl','plugins-facts');for(const [label,value] of data.rows)dl.append(make('dt','',label),make('dd','',value));detail.append(dl);
   if(typeof api==='function'&&row.actionHandle){
    const actionContainer=make('section','plugins-actions'),choose=make('button','subtle',row.installed===true?'准备卸载':'准备安装');choose.type='button';
    choose.disabled=uncertainActions.has(row.key);if(choose.disabled)actionContainer.append(make('p','','此插件有尚未核实的操作结果，禁止重试。请核查已安装状态。'));
    const confirmation=make('div');actionContainer.append(choose,confirmation);detail.append(actionContainer);
    actionPanel=mountPluginActionsPanel(confirmation,{
     plan:(handle,action)=>api('/api/plugins/plan',{handle,action}),
     apply:async params=>{
      if(uncertainActions.has(row.key))throw new Error('Unresolved plugin action');
      uncertainActions.add(row.key);choose.disabled=true;
      const result=await api('/api/plugins/apply',{requestId:requestId(),...params});
      if(['succeeded','not-executed'].includes(result?.outcome))uncertainActions.delete(row.key);
      return result;
     },
     onChanged:()=>{status.textContent='插件信息已变化，请刷新目录并重新查看，不会自动继续操作。';},
     onResult:result=>{choose.disabled=true;status.textContent=result?.outcome==='succeeded'?'插件操作已返回成功，请刷新目录核查当前状态。':result?.outcome==='not-executed'?'插件操作未提交，请刷新后重新核对。':'插件操作结果未知，禁止自动重试；请核查官方已安装状态。';}
    });
    choose.addEventListener('click',()=>{if(uncertainActions.has(row.key))return;actionPanel?.select({handle:row.actionHandle,action:row.installed===true?'uninstall':'install'});});
   }
  }catch(e){if(valid(g,key)&&d===detailGeneration)showDetail(make('p','',errorLabel(e,'插件详情')));}
 }
 refresh.addEventListener('click',refreshList);search.addEventListener('input',()=>{page=0;render();});installed.addEventListener('change',()=>{page=0;render();});remote.addEventListener('change',refreshList);
 detail.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();detailGeneration++;disposeAction();detail.hidden=true;refresh.focus();}});
 return {activate(){if(disposed)return;active=true;return refreshList();},refresh:refreshList,deactivate(){disposeAction();active=false;generation++;detailGeneration++;busy=false;refresh.disabled=false;remote.disabled=false;},reset(){disposeAction();generation++;detailGeneration++;rows=[];busy=false;refresh.disabled=false;remote.disabled=false;detail.hidden=true;list.replaceChildren();status.textContent='连接或工作目录已改变，请刷新目录。';},destroy(){disposeAction();disposed=true;active=false;generation++;detailGeneration++;container.replaceChildren();}};
}
