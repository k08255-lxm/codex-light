// Explicit account actions only. Caller supplies a durable mutation-ID adapter.
// Links and device codes live only in this mounted panel; never storage, logs or telemetry.
export function officialLoginUrl(value){
 if(typeof value!=='string'||value.length>16384)throw new Error('官方登录地址无效。');
 let url;try{url=new URL(value);}catch{throw new Error('官方登录地址无效。');}
 if(url.protocol!=='https:'||!['auth.openai.com','chatgpt.com'].includes(url.hostname)||url.username||url.password||url.port)throw new Error('仅允许已验证的官方 HTTPS 登录地址。');return url.href;
}
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
const STATES=new Set(['idle','starting','waiting','completed','failed','canceling','canceled','loggingOut','loggedOut','unknown','closed']);
const LABELS={idle:'尚未发起登录。',starting:'正在请求官方登录流程…',waiting:'等待官方确认登录；打开页面或输入设备码不代表已登录。',completed:'官方已确认此次登录完成。',failed:'官方未确认登录成功。',canceling:'正在取消当前登录…',canceled:'当前登录已取消。',loggingOut:'正在退出共享 Codex 账户…',loggedOut:'官方已返回退出完成。',unknown:'操作结果未知；已禁止重复发起。请只读刷新账号状态。',closed:'账户服务已关闭。'};
export function mountAccountLoginPanel(container,{api,onAccountChanged=()=>{}}){
 const doc=container.ownerDocument,make=(tag,text,className)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
 const title=make('h2','登录与退出'),intro=make('p','使用本机 Codex 的官方登录流程。账户由共享 CODEX_HOME 使用，改变登录状态会影响使用同一配置的 CLI 与桌面端。','account-login-note');
 const actions=make('div',undefined,'actions'),web=make('button','网页登录','subtle'),device=make('button','设备码登录','subtle'),cancel=make('button','取消当前登录','subtle'),logout=make('button','退出共享账户','subtle'),refresh=make('button','只读刷新账号','subtle');
 for(const button of [web,device,cancel,logout,refresh]){button.type='button';actions.append(button);}
 const status=make('p',LABELS.idle,'account-login-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const handoff=make('div',undefined,'account-login-handoff');handoff.hidden=true;container.append(title,intro,actions,status,handoff);
 let state='idle',loginId=null,busy=false,disposed=false,active=true,generation=0,secret=null,clearTimer=null,message='';const finished=new Set();
 const confirm=message=>{const fn=doc.defaultView?.confirm||globalThis.confirm;return typeof fn==='function'&&fn.call(doc.defaultView||globalThis,message)===true;};
 const clear=()=>{clearTimeout(clearTimer);clearTimer=null;secret=null;handoff.replaceChildren();handoff.hidden=true;};
 function render(){
  const canStart=['idle','completed','failed','canceled','loggedOut'].includes(state)&&!loginId;
  web.disabled=device.disabled=disposed||busy||!active||!canStart;cancel.disabled=disposed||busy||!active||state!=='waiting'||!loginId;
  logout.disabled=disposed||busy||!active||['starting','canceling','loggingOut','unknown','closed'].includes(state);refresh.disabled=disposed||busy||!active;
  status.textContent=message||LABELS[state]||'未知账户状态。';
 }
 async function changed(){try{await onAccountChanged();}catch{if(active&&!disposed){message='账户操作已返回，但只读账号刷新失败；没有重试登录。';render();}}}
 function update(snapshot,{operationConfirmed=false,fromSnapshot=false}={}){
  if(disposed||!snapshot||!STATES.has(snapshot.state))return;
  const incoming=validId(snapshot.loginId)?snapshot.loginId:null;
  if(state==='unknown'&&!operationConfirmed&&['idle','completed','failed'].includes(snapshot.state)&&(!incoming||incoming!==loginId))return;
  message='';
  if(['completed','failed'].includes(snapshot.state)){
   if(!incoming||incoming!==loginId){if(operationConfirmed||(fromSnapshot&&state!=='unknown')){const matchedBefore=state===snapshot.state;state=snapshot.state;loginId=null;clear();message=matchedBefore?'':'官方服务报告流程已结束，但未提供可匹配的登录标识；请以只读账号状态为准。';render();}return;}
   state=snapshot.state;loginId=null;clear();render();if(!finished.has(incoming)){finished.add(incoming);if(finished.size>64)finished.delete(finished.values().next().value);if(snapshot.state==='completed')void changed();}return;
  }
  if(snapshot.state==='waiting'){
   if(!incoming||(loginId&&incoming!==loginId))return;loginId=incoming;state='waiting';
  }else{state=snapshot.state;if(['idle','canceled','loggedOut','closed'].includes(state))loginId=null;if(state!=='starting')clear();}
  render();
 }
 function present(result){
  const url=officialLoginUrl(result.type==='chatgpt'?result.authUrl:result.verificationUrl);
  if(result.type==='chatgptDeviceCode'&&(typeof result.userCode!=='string'||!result.userCode||result.userCode.length>128||/[\x00-\x1f\x7f]/.test(result.userCode)))throw new Error('设备码无效。');
  secret={url,userCode:result.type==='chatgptDeviceCode'?result.userCode:null};handoff.replaceChildren();
  const link=make('a',result.type==='chatgpt'?'打开官方登录页面':'打开官方设备验证页面');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';handoff.append(link);
  if(secret.userCode){handoff.append(make('p','请在官方页面输入此临时设备码：'));const code=make('code',secret.userCode,'account-device-code');handoff.append(code);}
  handoff.append(make('p','仅供当前登录流程使用。离开此页会清除本机显示；不会把点击链接当作成功。','account-login-note'));handoff.hidden=false;clearTimer=setTimeout(()=>{clear();message='临时登录信息已从本机显示清除（10 分钟）。这不是官方设备码有效期，也不代表登录取消；请刷新状态或取消当前流程。';render();},10*60*1000);
 }
 async function start(type){
  if(disposed||busy||!active||!['idle','completed','failed','canceled','loggedOut'].includes(state)||loginId)return;
  const g=++generation;busy=true;message='';state='starting';clear();render();
  try{
   // api must inject the existing durable requestId; it must never auto-retry mutations.
   const result=await api('/api/account/start',{type});
   if(disposed||!active||g!==generation)return;
   if(!validId(result?.loginId)||result.type!==type||(loginId&&loginId!==result.loginId))throw new Error('官方登录响应需核对。');
   if(finished.has(result.loginId))return;
   loginId=result.loginId;state='waiting';if(result.redacted===true){clear();message='临时登录链接与设备码已清除；不会自动新建登录流程。请刷新状态或取消当前流程。';}else present(result);
  }catch{if(g===generation&&!disposed){state='unknown';clear();}}
  finally{if(g===generation&&!disposed){busy=false;render();}}
 }
 async function cancelCurrent(){
  if(disposed||busy||!active||state!=='waiting'||!loginId)return;const id=loginId,g=++generation;busy=true;message='';state='canceling';clear();render();
  try{await api('/api/account/cancel',{loginId:id});if(g!==generation||disposed)return;loginId=null;state='canceled';}
  catch{if(g===generation&&!disposed)state='unknown';}finally{if(g===generation&&!disposed){busy=false;render();}}
 }
 async function logoutCurrent(){
  if(logout.disabled||!confirm('退出共享 Codex 账户？使用同一 CODEX_HOME 的 Codex CLI 和桌面端也可能需要重新登录。当前登录流程会被取消；不保证其他客户端任务继续。'))return;
  const g=++generation;busy=true;message='';state='loggingOut';clear();render();try{await api('/api/account/logout',{confirmed:true});if(g!==generation||disposed)return;state='loggedOut';loginId=null;await changed();}catch{if(g===generation&&!disposed)state='unknown';}finally{if(g===generation&&!disposed){busy=false;render();}}
 }
 async function refreshState(){if(disposed||busy||!active)return;const g=generation;busy=true;message='';render();try{const snapshot=await api('/api/account/snapshot',{});if(g!==generation||disposed||!active)return;update(snapshot,{fromSnapshot:true});await changed();}catch{if(g===generation&&!disposed)message='只读刷新失败；未重试登录或退出。';}finally{if(g===generation&&!disposed){busy=false;render();}}}
 web.addEventListener('click',()=>start('chatgpt'));device.addEventListener('click',()=>start('chatgptDeviceCode'));cancel.addEventListener('click',cancelCurrent);logout.addEventListener('click',logoutCurrent);refresh.addEventListener('click',refreshState);
 render();return {update,activate(){if(disposed)return;active=true;render();return refreshState();},deactivate(){active=false;generation++;busy=false;clear();render();},destroy(){disposed=true;active=false;generation++;clear();container.replaceChildren();}};
}
