import {icon} from '../icons.js';

export function updateIndicatorState(status){
 const visible=!!status?.latest?.available&&status.supported===true&&!status.demo&&
  !['launched','launchUnknown'].includes(status.phase);
 const labels={downloading:'正在下载更新',ready:'更新已就绪',launching:'正在准备更新',failed:'更新未完成，查看详情'};
 const label=labels[status?.phase]||'有可用更新';
 return {visible,label,version:status?.latest?.version||'',busy:['downloading','launching'].includes(status?.phase)};
}

// Navigation only: this entry never downloads, installs, or bypasses the About confirmation.
export function mountUpdateIndicator(host,{onOpen}){
 const document=host.ownerDocument;
 const button=document.createElement('button');button.id='app-update-indicator';button.type='button';
 button.className='rail-btn update-indicator';button.hidden=true;
 const badge=document.createElement('span');badge.className='update-indicator-badge';badge.append(icon(document,'download'));button.append(badge);
 button.addEventListener('click',()=>{if(!button.hidden)onOpen();});
 host.insertBefore(button,host.children[1]||null);
 return {update(status){
  const next=updateIndicatorState(status);button.hidden=!next.visible;
  button.title=next.label;button.setAttribute('aria-label',`${next.label}${next.version?'，版本 '+next.version:''}，查看更新`);
  button.dataset.busy=String(next.busy);
 },button};
}
