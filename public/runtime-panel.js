import {icon} from './icons.js';

const STABLE_VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CHECK_TTL=20*60*1000;
const RECOVERY_INTERVAL=10000;
const SOURCE_LABELS=Object.freeze({auto:'自动选择',configured:'显式配置',npm:'npm CLI',desktop:'官方桌面内置',demo:'演示模式',env:'环境变量指定',path:'显式路径指定',private:'码舱自带引擎',wsl:'WSL'});
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const stableVersion=value=>typeof value==='string'&&value.length<=256&&STABLE_VERSION.test(value);
const stringOrNull=value=>typeof value==='string'&&value?value:null;
const candidate=value=>({available:value?.available===true,path:stringOrNull(value?.path),version:stringOrNull(value?.version),source:stringOrNull(value?.source)});
const validLatest=value=>!!value&&stableVersion(value.version)&&typeof value.checkedAt==='string'&&Number.isFinite(Date.parse(value.checkedAt));
const notExecuted=error=>error?.notExecuted===true||error?.outcome==='not-executed'||error?.outcome==='notExecuted';
function sourceLabel(value){
 if(!value)return '未知';
 return Object.hasOwn(SOURCE_LABELS,value)?SOURCE_LABELS[value]:value;
}
function localTimestamp(value){
 const parsed=Date.parse(value);
 if(!Number.isFinite(parsed))return String(value||'未知');
 const date=new Date(parsed);
 const pad=number=>String(number).padStart(2,'0');
 return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function errorMessage(error,fallback){
 const message=typeof error==='string'?error.trim():typeof error?.message==='string'?error.message.trim():'';
 return message?message.slice(0,500):fallback;
}
function outcomeDetail(result){return errorMessage(result?.error,'');}
function normalizeStatus(value){
 if(!plain(value))throw new Error('运行引擎状态格式无效');
 let latest=null,latestInvalid=false;
 if(value.latest!==null&&value.latest!==undefined){
  if(plain(value.latest)&&validLatest(value.latest))latest={version:value.latest.version,checkedAt:value.latest.checkedAt,stale:value.latest.stale===true};
  else latestInvalid=true;
 }
 return{current:candidate(value.current),npm:candidate(value.npm),desktop:candidate(value.desktop),latest,latestInvalid,canQueueUpgrade:value.canQueueUpgrade===true&&!!latest,canUpgrade:value.canUpgrade===true&&!!latest,blockedReason:typeof value.blockedReason==='string'&&value.blockedReason?value.blockedReason:null,upgrading:value.upgrading===true,automatic:plain(value.automatic)?value.automatic:null,startupError:stringOrNull(value.startupError)};
}
export function mountRuntimePanel(container,{read,check,upgrade,configure,queryPending,onRecovered,clock=Date.now,setTimeout: scheduleTimeout=(...args)=>globalThis.setTimeout(...args),clearTimeout: cancelTimeout=(...args)=>globalThis.clearTimeout(...args)}={}){
 if(!container||!container.ownerDocument)throw new TypeError('container required');
 if([read,check,upgrade].some(callback=>typeof callback!=='function'))throw new TypeError('read/check/upgrade callbacks required');
 if(queryPending!==undefined&&typeof queryPending!=='function')throw new TypeError('queryPending must be a function');
 if(onRecovered!==undefined&&typeof onRecovered!=='function')throw new TypeError('onRecovered must be a function');
 if(typeof scheduleTimeout!=='function'||typeof cancelTimeout!=='function')throw new TypeError('timer callbacks required');
 const doc=container.ownerDocument;
 let snapshot=null,busy=false,disposed=false,generation=0,upgradeInFlight=false;
 let active=false,pending=false,refreshTimer=null,activityGeneration=0;
 const el=(tag,value,className)=>{const node=doc.createElement(tag);if(value!==undefined)node.textContent=value;if(className)node.className=className;return node;};
 const section=el('section',undefined,'settings-section runtime-panel');
 const header=el('header',undefined,'engine-header'),title=el('h1','引擎更新');
 const checkedAt=el('span','','engine-checked'),checkButton=el('button','检查更新','btn engine-check');
 checkButton.type='button';checkButton.prepend(icon(doc,'refresh',{size:15}));
 const toolbar=el('div',undefined,'engine-toolbar');toolbar.append(checkedAt,checkButton);header.append(title,toolbar);
 const status=el('p','','runtime-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const tableHead=el('div',undefined,'engine-columns'),count=el('span','已安装');
 tableHead.append(count,el('span','版本'),el('span',''));
 const rows=el('div',undefined,'engine-list');
 const queueButton=el('button','下次启动升级','btn engine-queue');queueButton.type='button';
 const upgradeButton=el('button','升级','btn engine-upgrade');upgradeButton.type='button';upgradeButton.prepend(icon(doc,'up',{size:14}));
 const preferences=el('div',undefined,'runtime-preferences');preferences.hidden=true;
 const preference=(label,description,control)=>{
  const line=el('label',undefined,'pref-row'),copy=el('div');copy.append(el('strong',label));if(description)copy.append(el('small',description,'fine'));
  line.append(copy,control);return line;
 };
 const source=el('select'),sourceOptions=new Map();
 for(const [value,label] of [['auto','自动选择'],['npm','全局 npm CLI'],['desktop','官方客户端内建']]){const option=el('option',label);option.value=value;sourceOptions.set(value,option);source.append(option);}
 source.setAttribute('aria-label','下次启动的 Windows 引擎来源');
 const autoCheck=el('input'),autoInstall=el('input');autoCheck.type=autoInstall.type='checkbox';
 preferences.append(preference('下次启动的来源',null,source),preference('自动检查 npm 更新',null,autoCheck),preference('下次启动前安装 npm 更新','完全退出再打开时安装，托盘模式仍在运行。',autoInstall));
 const automaticStatus=el('p','','runtime-intro');automaticStatus.setAttribute('role','status');preferences.append(automaticStatus);
 const options=el('details',undefined,'engine-options');options.append(el('summary','启动与自动更新设置'),preferences);
 section.append(header,tableHead,rows,status,options);container.replaceChildren(section);
 const now=()=>{try{const value=clock();return Number.isFinite(value)?value:Date.now();}catch{return Date.now();}};
 const latestFresh=latest=>!!latest&&!latest.stale&&validLatest(latest)&&(()=>{const age=now()-Date.parse(latest.checkedAt);return Number.isFinite(age)&&age>=0&&age<=CHECK_TTL;})();
 const canUpgradeNow=()=>!pending&&!upgradeInFlight&&!!snapshot&&!snapshot.upgrading&&!snapshot.blockedReason&&snapshot.canUpgrade===true&&latestFresh(snapshot.latest);
 const say=value=>{status.textContent=value;};
 function engineRow(label,kind,engine,running,managed){
  const wrapper=el('div',undefined,'engine-row'),identity=el('div',undefined,'engine-identity');
  const glyph=el('span',undefined,'engine-glyph');glyph.append(icon(doc,kind==='desktop'?'computer':'terminal',{size:22}));
  const copy=el('div',undefined,'engine-copy'),name=el('div',undefined,'engine-name');
  name.append(el('strong',label),el('span',kind==='npm'?'npm':sourceLabel(kind),'engine-source'));
  if(running)name.append(el('span','使用中','engine-active'));
  const path=el('code',engine.path||'','engine-path');path.title=engine.path||'';copy.append(name,path);identity.append(glyph,copy);
  const version=el('div',undefined,'engine-version');version.append(el('strong',engine.version||'未知版本'));
  const action=el('div',undefined,'engine-action');
  if(managed){
   if(snapshot.latest&&stableVersion(engine.version)&&engine.version!==snapshot.latest.version&&(snapshot.canUpgrade||snapshot.canQueueUpgrade))version.append(el('small','有新版本 '+snapshot.latest.version));
   action.append(upgradeButton,queueButton);
   const queued=snapshot.automatic?.queueOnce;
   queueButton.hidden=!configure||!snapshot.automatic||(!queued&&(!snapshot.canQueueUpgrade||snapshot.automatic.explicit||snapshot.automatic.source==='desktop'||snapshot.current.source!=='npm'));
   queueButton.textContent=queued?'取消预约':'下次启动升级';
   if(queued)version.append(el('small','已预约 '+snapshot.automatic.queuedVersion));
  }else if(kind==='desktop')version.append(el('small','随桌面客户端更新'));
  wrapper.append(identity,version,action);return wrapper;
 }
 function renderRows(){
  rows.replaceChildren();checkedAt.textContent='';count.textContent='已安装';
  options.hidden=!snapshot?.automatic||typeof configure!=='function';
  preferences.hidden=options.hidden;
  if(!snapshot)return;
  const {current,npm,desktop,latest}=snapshot;
  const engines=[];
  const matches=engine=>engine.path&&current.path&&engine.path.toLowerCase()===current.path.toLowerCase();
  const usesNpm=npm.available&&(current.source==='npm'||matches(npm));
  const usesDesktop=desktop.available&&(current.source==='desktop'||matches(desktop));
  if(npm.available)engines.push(engineRow('Codex CLI','npm',npm,usesNpm,true));
  if(desktop.available)engines.push(engineRow('Codex Desktop','desktop',desktop,usesDesktop,false));
  if(current.path&&!usesNpm&&!usesDesktop)engines.push(engineRow('Codex CLI',current.source,current,true,false));
  count.textContent='已安装 · '+engines.length;
  rows.append(...engines);
  if(!engines.length)rows.append(el('p',snapshot.startupError||'未检测到可用的 Windows 引擎。','engine-empty'));
  if(latest){checkedAt.textContent='上次检查 '+localTimestamp(latest.checkedAt).slice(11,16);checkedAt.title=localTimestamp(latest.checkedAt);}
  if(snapshot.blockedReason)rows.append(el('p',snapshot.blockedReason,'runtime-blocked'));
  const automatic=snapshot.automatic;
  if(!preferences.hidden){
   source.value=sourceOptions.has(automatic.source)?automatic.source:'auto';
   for(const key of ['npm','desktop'])sourceOptions.get(key).disabled=!snapshot[key].available||!snapshot[key].version;
   autoCheck.checked=automatic.checkAutomatically===true;autoInstall.checked=automatic.installOnRestart===true;
   automaticStatus.textContent=automatic.error||(automatic.explicit?'当前由显式路径指定，使用原安装渠道更新。':
    automatic.phase==='preflight'?'正在核对下次启动前的 npm 更新。':
    automatic.phase==='installing'?`正在启动前安装 npm CLI ${automatic.queuedVersion}。`:
    automatic.phase==='checking'?'正在检查 npm 稳定版。':
    automatic.result?.outcome==='unknown'?(automatic.result.message||'上次更新未确认完成。'):
    automatic.queuedVersion?`已安排 npm CLI ${automatic.queuedVersion} 在下次启动前安装。${automatic.result?.outcome==='deferred'?' '+(automatic.result.message||''):''}`:
    automatic.result?.outcome==='succeeded'?`已验证 npm CLI ${automatic.result.version} 的安装。`:
    automatic.result?.message||''
   );
  }
 }
 function state(){
  checkButton.disabled=busy;
  queueButton.disabled=busy||pending||upgradeInFlight||(!snapshot?.automatic?.queueOnce&&!latestFresh(snapshot?.latest));
  upgradeButton.disabled=busy||!canUpgradeNow();
  upgradeButton.hidden=!snapshot?.canUpgrade&&!upgradeInFlight;
  if(snapshot?.latest)upgradeButton.setAttribute('aria-label','升级 Codex CLI 到 '+snapshot.latest.version);
  const automatic=snapshot?.automatic;
  const locked=busy||!automatic||['preflight','installing'].includes(automatic.phase);
  source.disabled=locked||automatic.explicit===true;
  const targetsNpm=automatic?.source==='npm'||(automatic?.source==='auto'&&snapshot?.current.source==='npm');
  autoCheck.disabled=locked||automatic.explicit===true||!targetsNpm;
  autoInstall.disabled=locked||automatic.explicit===true||(!targetsNpm&&!autoInstall.checked);
  container.setAttribute('aria-busy',String(busy));
 }
 function clearAutoTimer(){if(refreshTimer!==null)cancelTimeout(refreshTimer);refreshTimer=null;}
 function scheduleRefresh(delay=RECOVERY_INTERVAL){
  clearAutoTimer();
  if(!active||disposed||busy||(!pending&&!snapshot?.upgrading))return;
  refreshTimer=scheduleTimeout(()=>{refreshTimer=null;void load('read',{automatic:true});},delay);
 }
 async function load(mode,{automatic=false}={}){
  if(busy||disposed||(automatic&&!active))return false;
  clearAutoTimer();
  const version=generation,activity=activityGeneration;
  const current=()=>!disposed&&version===generation&&(!automatic||(active&&activity===activityGeneration));
  busy=true;state();
  say(mode==='read'?'正在读取本机运行引擎…':'正在检查更新…');
  let queryError=null,queryResult=null;
  try{
   if(pending&&typeof queryPending==='function'){
    try{queryResult=await queryPending();}catch(error){queryError=error;}
    if(!current())return false;
   }
   let value=await (mode==='check'?check:read)();
   if(mode==='enter'&&current()&&!value?.upgrading){snapshot=normalizeStatus(value);renderRows();value=await check();}
   if(!current())return false;
   snapshot=normalizeStatus(value);renderRows();
   if(pending&&!queryError&&queryResult?.outcome!=='pending'&&!snapshot.upgrading&&snapshot.npm.available&&stableVersion(snapshot.npm.version)){
    pending=false;onRecovered?.(snapshot);
    say(`当前 npm CLI 为 ${snapshot.npm.version}；可正常检查更新。`);
   }else if(queryError)say(`${errorMessage(queryError,'升级状态读取失败')}；页面会自动重试。`);
   else if(snapshot.upgrading)say('升级正在处理中；页面会自动刷新状态。');
   else if(pending)say('升级状态仍在同步；页面会自动刷新实际版本。');
   else say(snapshot.latestInvalid?'版本检查返回了无效数据，请重试。':'');
   return true;
  }catch(error){
   if(current()){if(snapshot)snapshot={...snapshot,canUpgrade:false,canQueueUpgrade:false};renderRows();say(errorMessage(error,mode!=='read'?'检查更新失败。':'读取运行引擎状态失败。'));}
   return false;
  }finally{
   if(!disposed&&version===generation){
    busy=false;state();
    if(active&&activity!==activityGeneration&&!pending&&!snapshot?.upgrading)void load('enter',{automatic:true});
    else scheduleRefresh(activity===activityGeneration?RECOVERY_INTERVAL:0);
   }
  }
 }
 async function startUpgrade(){
  if(busy||disposed||!canUpgradeNow())return;
  const target=snapshot.latest.version,version=generation;
  clearAutoTimer();busy=true;upgradeInFlight=true;state();say(`正在升级 npm CLI 到 ${target}…`);
  try{
   const result=await upgrade({version:target,confirmed:true});
   if(disposed||version!==generation)return;
   if(result?.outcome==='succeeded'&&result.installedVersion===target&&result.restartRequired===true){
    pending=false;snapshot={...snapshot,npm:{...snapshot.npm,version:target},canUpgrade:false};renderRows();say(`npm CLI 已升级到 ${target}，重启码舱后生效。`);
   }else if(result?.outcome==='not-executed'){
    pending=false;const detail=outcomeDetail(result);say(`${detail?detail+'。':''}升级未执行；当前以实际 npm 版本为准，不会自动重试。`);
   }else{
    pending=true;const detail=outcomeDetail(result);say(`${detail?detail+'。':''}升级结果暂未确认；页面会自动读取实际版本，不会自动再次安装。`);
   }
  }catch(error){
   if(disposed||version!==generation)return;
   if(notExecuted(error)){pending=false;say(`${errorMessage(error,'升级未执行')}。没有报告安装成功，不会自动重试。`);}
   else{pending=true;say(`${errorMessage(error,'升级结果暂未确认')}。页面会自动读取实际版本，不会自动再次安装。`);}
  }finally{
   // Reset cannot cancel an already dispatched installation. Keep its guard until it settles.
   upgradeInFlight=false;
   if(!disposed){if(version===generation)busy=false;state();scheduleRefresh(pending?0:RECOVERY_INTERVAL);}
  }
 }
 async function savePreference(patch){
  if(busy||disposed||preferences.hidden)return;
  const started=generation;busy=true;state();say('正在保存运行引擎设置…');
  try{
   const result=await configure(patch);
   if(disposed||started!==generation)return;
   snapshot=normalizeStatus(result);renderRows();say(Object.hasOwn(patch,'queueVersion')?(patch.queueVersion?'已预约升级，完全退出并重新打开码舱后安装。':'已取消单次升级。'):Object.hasOwn(patch,'source')?'已保存，完全退出并重新打开码舱后使用所选来源。':'已保存运行引擎设置。');
  }catch(error){if(!disposed&&started===generation){renderRows();say(errorMessage(error,'保存失败，请重新读取设置。'));}}
  finally{if(!disposed&&started===generation){busy=false;state();scheduleRefresh();}}
 }
 function reset({pending:restorePending=false}={}){
  clearAutoTimer();generation++;snapshot=null;busy=false;pending=restorePending||upgradeInFlight;
  renderRows();state();say(pending?'连接恢复后会自动读取实际 npm 版本。':'已清空运行引擎状态；进入设置后读取本机版本。');
  scheduleRefresh(0);
 }
 function destroy(){clearAutoTimer();generation++;disposed=true;snapshot=null;busy=false;container.setAttribute('aria-busy','false');container.replaceChildren();}
 function setActive(next){
  if(disposed||active===!!next)return;
  active=!!next;activityGeneration++;clearAutoTimer();
  if(!active)return;
  if(pending||snapshot?.upgrading)scheduleRefresh(0);
  else void load('enter',{automatic:true});
 }
 checkButton.addEventListener('click',()=>load('check'));
 upgradeButton.addEventListener('click',startUpgrade);
 queueButton.addEventListener('click',()=>{
  if(queueButton.hidden||queueButton.disabled)return;
  return savePreference({queueVersion:snapshot.automatic.queueOnce?null:snapshot.latest.version});
 });
 source.addEventListener('change',()=>savePreference({source:source.value}));
 autoCheck.addEventListener('change',()=>savePreference({checkAutomatically:autoCheck.checked}));
 autoInstall.addEventListener('change',()=>savePreference({installOnRestart:autoInstall.checked}));
 renderRows();state();
 return{refresh(){return load('read');},updateAvailable(){if(active&&!busy)void load('read',{automatic:true});},setActive,reset,destroy};
}
