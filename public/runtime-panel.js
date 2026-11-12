const STABLE_VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CHECK_TTL=20*60*1000;
const RECOVERY_INTERVAL=10000;
const SOURCE_LABELS=Object.freeze({configured:'显式配置',npm:'npm CLI',desktop:'官方桌面内置',demo:'演示模式',env:'环境变量指定',path:'显式路径指定'});
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
 return{current:candidate(value.current),npm:candidate(value.npm),desktop:candidate(value.desktop),latest,latestInvalid,canUpgrade:value.canUpgrade===true&&!!latest,blockedReason:typeof value.blockedReason==='string'&&value.blockedReason?value.blockedReason:null,upgrading:value.upgrading===true};
}
export function mountRuntimePanel(container,{read,check,upgrade,queryPending,onRecovered,clock=Date.now,setTimeout: scheduleTimeout=(...args)=>globalThis.setTimeout(...args),clearTimeout: cancelTimeout=(...args)=>globalThis.clearTimeout(...args)}={}){
 if(!container||!container.ownerDocument)throw new TypeError('container required');
 if([read,check,upgrade].some(callback=>typeof callback!=='function'))throw new TypeError('read/check/upgrade callbacks required');
 if(queryPending!==undefined&&typeof queryPending!=='function')throw new TypeError('queryPending must be a function');
 if(onRecovered!==undefined&&typeof onRecovered!=='function')throw new TypeError('onRecovered must be a function');
 if(typeof scheduleTimeout!=='function'||typeof cancelTimeout!=='function')throw new TypeError('timer callbacks required');
 const doc=container.ownerDocument;
 let snapshot=null,busy=false,disposed=false,generation=0,upgradeInFlight=false,confirmationOpen=false,confirmTarget=null,confirmSnapshot=null;
 let active=false,pending=false,refreshTimer=null,activityGeneration=0;
 const el=(tag,value,className)=>{const node=doc.createElement(tag);if(value!==undefined)node.textContent=value;if(className)node.className=className;return node;};
 const section=el('section',undefined,'settings-section runtime-panel');
 const title=el('h2','运行引擎与更新');
 const intro=el('p','这里只管理后台 Codex 引擎和 npm CLI，不需要打开或更新官方桌面界面，也不会自动启动官方界面。 “刷新版本”只读取本机状态；“检查更新”仅在你点击时读取官方 npm registry；安装完成后需下次重启 Codex Light 才生效。','runtime-intro');
 const status=el('p','尚未读取运行引擎状态。进入设置或点击“刷新版本”后读取；不会自动联网。','runtime-status');
 status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');
 const rows=el('div',undefined,'runtime-setting-rows');
 const actions=el('div',undefined,'runtime-actions');
 const refreshButton=el('button','刷新版本'),checkButton=el('button','检查更新'),upgradeButton=el('button','升级 npm CLI');
 for(const button of [refreshButton,checkButton,upgradeButton]){button.type='button';actions.append(button);}
 const confirmation=el('section',undefined,'runtime-confirm');confirmation.hidden=true;
 confirmation.setAttribute('role','group');confirmation.setAttribute('aria-live','polite');confirmation.setAttribute('aria-atomic','true');confirmation.setAttribute('aria-labelledby','runtime-confirm-title');confirmation.setAttribute('aria-describedby','runtime-confirm-note');
 const confirmTitle=el('strong',undefined,'确认升级运行引擎');confirmTitle.id='runtime-confirm-title';
 const confirmNote=el('p','先下载并验证新引擎，再替换 npm 安装。完成后重启 Codex Light 生效。','runtime-confirm-note');confirmNote.id='runtime-confirm-note';
 const confirmTargetLine=el('p',undefined,'runtime-confirm-target');
 const confirmTargetCode=el('code','未提供');
 confirmTargetLine.append(el('span','目标版本 '),confirmTargetCode);
 const confirmPathLine=el('p',undefined,'runtime-confirm-path');
 const confirmPathCode=el('code','未提供');
 confirmPathLine.append(el('span','全局 npm 位置 '),confirmPathCode);
 const confirmDesktop=el('p','官方桌面界面不会启动或更新。','runtime-confirm-desktop');
 const confirmActions=el('div',undefined,'runtime-confirm-actions');
 const confirmUpgradeButton=el('button',undefined,'runtime-confirm-upgrade'),cancelConfirmButton=el('button','取消');
 confirmUpgradeButton.type='button';cancelConfirmButton.type='button';
 confirmActions.append(confirmUpgradeButton,cancelConfirmButton);
 confirmation.append(confirmTitle,confirmNote,confirmTargetLine,confirmPathLine,confirmDesktop,confirmActions);
 section.append(title,intro,status,rows,actions,confirmation);container.replaceChildren(section);
 const now=()=>{try{const value=clock();return Number.isFinite(value)?value:Date.now();}catch{return Date.now();}};
 const latestFresh=latest=>!!latest&&!latest.stale&&validLatest(latest)&&(()=>{const age=now()-Date.parse(latest.checkedAt);return Number.isFinite(age)&&age>=0&&age<=CHECK_TTL;})();
 const canUpgradeNow=()=>!pending&&!upgradeInFlight&&!!snapshot&&!snapshot.upgrading&&!snapshot.blockedReason&&snapshot.canUpgrade===true&&latestFresh(snapshot.latest);
 const say=value=>{status.textContent=value;};
 function row(label,values,path){const wrapper=el('div',undefined,'setting-row'),copy=el('div',undefined,'setting-row-copy');copy.append(el('strong',label));for(const value of values)copy.append(el('p',value));wrapper.append(copy);if(path!==undefined){const details=el('details',undefined,'setting-row-path');details.append(el('summary','安装位置'),el('code',path||'未提供'));wrapper.append(details);}return wrapper;}
 function renderRows(){
  rows.replaceChildren();
  if(!snapshot)return;
  rows.append(row('当前引擎',[`来源：${sourceLabel(snapshot.current.source)}`,`版本：${snapshot.current.version??'未知'}`],snapshot.current.path));
  rows.append(row('npm CLI',snapshot.npm.available?[`版本：${snapshot.npm.version??'未知'}`]:['状态：不可用'],snapshot.npm.path));
  rows.append(row('桌面内置引擎',snapshot.desktop.available?[`版本：${snapshot.desktop.version??'未知'}`]:['状态：不可用'],snapshot.desktop.path));
  if(snapshot.latest){const values=[`版本：${snapshot.latest.version}`,`检查时间：${localTimestamp(snapshot.latest.checkedAt)}`];if(!latestFresh(snapshot.latest))values.push('检查结果已过期，请重新检查。');rows.append(row('最新稳定版',values));}
  else rows.append(row('最新稳定版',[snapshot.latestInvalid?'检查结果无效，请重新检查。':'尚未检查更新。点击“检查更新”获取 npm 最新稳定版。']));
  if(snapshot.blockedReason)rows.append(el('p',snapshot.blockedReason,'runtime-blocked'));
 }
 function state(){
  refreshButton.disabled=busy;checkButton.disabled=busy;
  upgradeButton.disabled=busy||confirmationOpen||!canUpgradeNow();
  confirmUpgradeButton.disabled=busy||!confirmationOpen;
  cancelConfirmButton.disabled=busy;
  container.setAttribute('aria-busy',String(busy));
 }
 function clearAutoTimer(){if(refreshTimer!==null)cancelTimeout(refreshTimer);refreshTimer=null;}
 function scheduleRefresh(delay=RECOVERY_INTERVAL){
  clearAutoTimer();
  if(!active||disposed||busy||(!pending&&!snapshot?.upgrading))return;
  refreshTimer=scheduleTimeout(()=>{refreshTimer=null;void load('read',{automatic:true});},delay);
 }
 function renderConfirmation(){
  const target=confirmTarget||'未知';
  confirmTitle.textContent=`确认升级到 ${target}`;
  confirmTargetCode.textContent=target;
  confirmPathCode.textContent=confirmSnapshot?.npm?.path||'未提供';
  confirmUpgradeButton.textContent=`确认升级到 ${target}`;
 }
 function hideConfirmation({focus=false}={}){
  const wasOpen=confirmationOpen;
  confirmationOpen=false;confirmTarget=null;confirmSnapshot=null;confirmation.hidden=true;
  state();
  if(focus&&wasOpen)upgradeButton.focus();
 }
 function showConfirmation(){
  if(busy||disposed||confirmationOpen||!canUpgradeNow())return;
  confirmSnapshot=snapshot;confirmTarget=snapshot.latest.version;confirmationOpen=true;
  renderConfirmation();confirmation.hidden=false;state();
  say(`请确认升级到 ${confirmTarget}；尚未发送安装请求。`);
  confirmUpgradeButton.focus();
 }
 function cancelConfirmation(){
  if(busy)return;
  hideConfirmation({focus:true});
  say('已取消升级确认；没有发送安装请求。');
 }
 async function load(mode,{automatic=false}={}){
  if(busy||disposed||(automatic&&!active))return false;
  clearAutoTimer();hideConfirmation();
  const version=generation,activity=activityGeneration;
  const current=()=>!disposed&&version===generation&&(!automatic||(active&&activity===activityGeneration));
  busy=true;state();
  if(!automatic)say(mode==='check'?'正在检查 npm 最新稳定版…':'正在读取本机运行引擎…');
  let queryError=null,queryResult=null;
  try{
   if(pending&&typeof queryPending==='function'){
    try{queryResult=await queryPending();}catch(error){queryError=error;}
    if(!current())return false;
   }
   const value=await (mode==='check'?check:read)();
   if(!current())return false;
   snapshot=normalizeStatus(value);renderRows();
   if(pending&&!queryError&&queryResult?.outcome!=='pending'&&!snapshot.upgrading&&snapshot.npm.available&&stableVersion(snapshot.npm.version)){
    pending=false;onRecovered?.(snapshot);
    say(`当前 npm CLI 为 ${snapshot.npm.version}；可正常检查更新。`);
   }else if(queryError)say(`${errorMessage(queryError,'升级状态读取失败')}；页面会自动重试。`);
   else if(snapshot.upgrading)say('升级正在处理中；页面会自动刷新状态。');
   else if(pending)say('升级状态仍在同步；页面会自动刷新实际版本。');
   else say(mode==='check'?'已检查更新。只有可用且版本有效时才会启用升级。':'已读取运行引擎状态。');
   return true;
  }catch(error){
   if(current()){if(snapshot)snapshot={...snapshot,canUpgrade:false};renderRows();say(errorMessage(error,mode==='check'?'检查更新失败。':'读取运行引擎状态失败。'));}
   return false;
  }finally{
   if(!disposed&&version===generation){
    busy=false;state();
    if(active&&activity!==activityGeneration&&!pending&&!snapshot?.upgrading)void load('read',{automatic:true});
    else scheduleRefresh(activity===activityGeneration?RECOVERY_INTERVAL:0);
   }
  }
 }
 async function startUpgrade(){
  if(busy||disposed||!confirmationOpen)return;
  const captured=confirmSnapshot,target=confirmTarget,version=generation;
  hideConfirmation();
  if(snapshot!==captured||snapshot?.latest?.version!==target||!canUpgradeNow()){
   say('升级条件已变化，未发送请求。请重新读取或检查。');state();return;
  }
  clearAutoTimer();busy=true;upgradeInFlight=true;state();say(`正在升级 npm CLI 到 ${target}…`);
  try{
   const result=await upgrade({version:target,confirmed:true});
   if(disposed||version!==generation)return;
   if(result?.outcome==='succeeded'&&result.installedVersion===target&&result.restartRequired===true){
    pending=false;snapshot=null;renderRows();say(`已确认 npm CLI 升级到 ${target}；重启 Codex Light 后生效。`);
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
 function reset({pending:restorePending=false}={}){
  clearAutoTimer();hideConfirmation();generation++;snapshot=null;busy=false;pending=restorePending||upgradeInFlight;
  rows.replaceChildren();state();say(pending?'连接恢复后会自动读取实际 npm 版本。':'已清空运行引擎状态；进入设置后读取本机版本。');
  scheduleRefresh(0);
 }
 function destroy(){clearAutoTimer();hideConfirmation();generation++;disposed=true;snapshot=null;busy=false;container.setAttribute('aria-busy','false');container.replaceChildren();}
 function setActive(next){
  if(disposed||active===!!next)return;
  active=!!next;activityGeneration++;clearAutoTimer();
  if(!active){hideConfirmation();return;}
  if(pending||snapshot?.upgrading)scheduleRefresh(0);
  else void load('read',{automatic:true});
 }
 refreshButton.addEventListener('click',()=>load('read'));
 checkButton.addEventListener('click',()=>load('check'));
 upgradeButton.addEventListener('click',showConfirmation);
 confirmUpgradeButton.addEventListener('click',startUpgrade);
 cancelConfirmButton.addEventListener('click',cancelConfirmation);
 renderRows();state();
 return{refresh(){return load('read');},setActive,reset,destroy};
}
