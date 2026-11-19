import {icon} from '../icons.js';

export function updateIndicatorState(status){
 const visible=!!status?.latest?.available&&status.supported===true&&!status.demo&&
  !['launched','launchUnknown'].includes(status.phase);
 const labels={checking:'正在检查更新',downloading:'正在下载更新',verifying:'正在校验安装包',ready:'更新已就绪',launching:'正在准备更新',staging:'正在准备安装',authorizing:'等待安装授权',confirm:'等待确认安装',installing:'等待系统安装',failed:'更新未完成，查看详情'};
 const label=labels[status?.phase]||'有可用更新';
 return {visible,label,version:status?.latest?.version||'',busy:['checking','downloading','verifying','launching','staging','installing'].includes(status?.phase)};
}

// The button opens the platform's update controls; downloading and installing are separate actions.
export function mountUpdateIndicator(host,{onOpen}){
 const document=host.ownerDocument;
 const button=document.createElement('button');button.id='app-update-indicator';button.type='button';
 button.className='rail-btn update-indicator';button.hidden=true;
 const badge=document.createElement('span');badge.className='update-indicator-badge';badge.append(icon(document,'download'));button.append(badge);
 button.addEventListener('click',()=>{if(!button.hidden)onOpen();});
 host.insertBefore(button,host.querySelector('#account-quota')||host.lastElementChild||null);
 return {update(status){
  const next=updateIndicatorState(status);button.hidden=!next.visible;
  button.title=next.label;button.setAttribute('aria-label',`${next.label}${next.version?'，版本 '+next.version:''}，查看更新`);
  button.dataset.busy=String(next.busy);
 },button};
}

export function mountAndroidUpdateIndicator(host,window,settingsButton){
 const bridge=window.CodexLightNative;
 let available=false;
 if(settingsButton&&typeof bridge?.checkForUpdates==='function'){
  settingsButton.addEventListener('click',()=>available?bridge.openAppUpdate():bridge.checkForUpdates());
 }
 if(typeof bridge?.getAppUpdateStatus!=='function'||typeof bridge.openAppUpdate!=='function')return null;
 const indicator=mountUpdateIndicator(host,{onOpen:()=>bridge.openAppUpdate()});
 function refresh(){
  let status;
  try{status=JSON.parse(bridge.getAppUpdateStatus());}catch{status=null;}
  const version=status?.version;
  available=typeof version==='string'&&/^(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){2}$/.test(version)&&
    ['checking','available','downloading','verifying','ready','failed','authorizing','staging','confirm','installing'].includes(status.phase);
  indicator.update({supported:true,phase:status?.phase,latest:{available,version:available?version:''}});
  if(settingsButton)settingsButton.textContent=available?`查看 v${version} 更新`:'检查更新';
 }
 window.addEventListener('codexlight-android-update-status',refresh);
 window.addEventListener('focus',refresh);
 refresh();
 return indicator;
}
