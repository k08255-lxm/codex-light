import {el,localTime} from './format.js';
import {renderMarkdown} from '../markdown.js';

const RELEASES='https://github.com/k08255-lxm/codex-light/releases';
const PHASE={idle:'随时检查新版本',checking:'正在检查更新…',available:'有新版本可用',upToDate:'当前已是最新版本',downloading:'正在下载安装包…',ready:'安装包已下载并通过校验',launching:'正在打开安装程序…',launched:'安装程序已打开',launchUnknown:'安装程序启动结果待确认',failed:'应用更新未完成'};
const bytes=value=>Number.isFinite(value)?`${(value/1024/1024).toFixed(1)} MiB`:'';

export function mountAbout(host,{api,mutate,onStatus=()=>{}}){
 const document=host.ownerDocument;
 let active=false,generation=0,revision=0,status=null,busy=null,error=null,readError=null,timer=null,currentRead=null,confirmInstall=false,uncertainInstall=false;
 host.classList.add('about-page');
 function button(text,action,{primary=false,disabled=false}={}){
  const node=el(document,'button','btn'+(primary?' primary':''),text);node.type='button';node.disabled=disabled;node.addEventListener('click',action);return node;
 }
 function render(){
  const header=el(document,'header','page-head');const titles=el(document,'div','page-titles');titles.append(el(document,'h1','','关于'),el(document,'p','page-sub','码舱 CodeCang 应用与版本更新'));header.append(titles);
  const intro=el(document,'section','about-intro');
  const title=el(document,'div','about-brand');title.append(el(document,'h2','','码舱 CodeCang'));
  if(status?.currentVersion)title.append(el(document,'span','about-version',`v${status.currentVersion}`));
  intro.append(title,el(document,'p','','轻量的本地 Codex 工作台。'));
  const update=el(document,'section','about-update');const updateHead=el(document,'div','about-update-head');
  const info=el(document,'div');info.append(el(document,'h2','','应用更新'));
  const phase=status?.phase||'idle';
  const inPlace=status?.updateTransport==='velopack';
  const starting=(busy==='install'||phase==='launching')&&!['launchUnknown','launched','failed'].includes(phase);
  const downloading=phase==='downloading'||busy==='download'&&!['ready','failed'].includes(phase);
  let label=status?PHASE[phase]||'更新状态不可用':'正在读取应用版本…';
  if(busy==='check')label=PHASE.checking;
  if(downloading)label=PHASE.downloading;
  if(starting)label=inPlace?'正在准备更新，等待安装窗口…':'正在打开安装程序…';
  if(phase==='launched'&&inPlace)label='已交给更新程序，码舱即将退出';
  const line=el(document,'p','about-update-status',label);line.setAttribute('role','status');info.append(line);
  if(status?.latest?.available&&status.latest.version){
   const download=bytes(status.latest.downloadBytes);
   info.append(el(document,'p','about-next-version',`新版本 v${status.latest.version}${download?' · '+(inPlace?'桌面更新包':'Windows 安装包')+' '+download:''}`));
  }
  updateHead.append(info);
  const controls=el(document,'div','about-update-controls');
  const locked=!!busy||['downloading','launching','launchUnknown','launched'].includes(phase);
  controls.append(button('检查更新',()=>run('check'),{disabled:locked||!status}));
  if(status?.supported&&!status.demo&&status?.latest?.available&&!['launched','launchUnknown'].includes(phase)){
   if(status.preparedVersion===status.latest.version)controls.append(button(starting?'正在启动…':inPlace?'安装更新':'打开安装程序',()=>{confirmInstall=true;render();host.querySelector('.about-confirm')?.querySelector('button')?.focus();},{primary:true,disabled:locked||uncertainInstall}));
   else controls.append(button(phase==='downloading'?'正在下载…':'下载更新',()=>run('download'),{primary:true,disabled:locked||uncertainInstall}));
  }
  updateHead.append(controls);update.append(updateHead);
  if(downloading||starting){
   const progress=el(document,'progress','about-download-progress');progress.setAttribute('aria-label',starting?label:'安装包下载进度');update.append(progress);
   if(phase==='downloading'&&status.totalBytes>0){
    progress.max=status.totalBytes;progress.value=Math.max(0,status.receivedBytes||0);
    update.append(el(document,'p','about-download-size',`${bytes(progress.value)} / ${bytes(progress.max)}`));
   }
  }
  if(error||readError||status?.error){const failure=el(document,'p','inline-error',error||readError||status.error);failure.setAttribute('role','alert');update.append(failure);}
  if(uncertainInstall||phase==='launchUnknown')update.append(el(document,'p','about-update-message','请先核对安装程序是否已打开。为避免重复启动，此次操作不会自动重试。'));
  else if(phase==='launched')update.append(el(document,'p','about-update-message',inPlace?'请在更新窗口查看安装进度和结果。':'请完全退出码舱（包括系统托盘），在安装程序中完成更新后重新打开应用。'));
  else if(status?.demo)update.append(el(document,'p','about-update-message','演示模式可检查发布信息，不能下载或安装应用更新。'));
  else if(status&&!status.supported)update.append(el(document,'p','about-update-message','应用内安装目前支持 Windows x64。可前往发布页面查看安装包。'));
  if(confirmInstall&&status?.preparedVersion&&!locked){
   const confirm=el(document,'div','about-confirm');confirm.append(el(document,'strong','',inPlace?`退出并更新到 v${status.preparedVersion}？`:`打开 v${status.preparedVersion} 安装程序？`),el(document,'p','',inPlace?'码舱将自动退出。更新窗口会显示安装进度和结果，对话和设置会保留。':'安装界面打开后，请完全退出码舱（包括系统托盘），再继续安装。对话和设置会保留。'));
   const actions=el(document,'div','about-confirm-actions');actions.append(button('取消',()=>{confirmInstall=false;render();}),button(inPlace?'退出并更新':'确认打开',()=>run('install'),{primary:true}));confirm.append(actions);update.append(confirm);
  }
  const latest=status?.latest;
  if(latest?.notes){
   const notes=el(document,'details','about-release-notes');notes.open=true;notes.append(el(document,'summary','',`v${latest.version} 发布说明`));
   notes.append(renderMarkdown(document,latest.notes));update.append(notes);
  }
  const footer=el(document,'div','about-links');const releases=el(document,'a','','GitHub 发布页面');releases.href=RELEASES;releases.target='_blank';releases.rel='noopener noreferrer';footer.append(releases);
  if(status?.checkedAt)footer.append(el(document,'span','',`上次检查 ${localTime(status.checkedAt)}`));
  host.replaceChildren(header,intro,update,footer);
 }
 function schedule(){
  clearTimeout(timer);timer=null;
  if(active&&(busy||['checking','downloading','launching'].includes(status?.phase)))timer=setTimeout(refresh,900);
 }
 function update(next){
  if(!next?.currentVersion)return;
  if(status?.preparedVersion!==next.preparedVersion)confirmInstall=false;
  status=next;revision++;currentRead=null;readError=null;
  if(next.phase==='launched')uncertainInstall=false;
  onStatus(next);
  if(active)render();
  schedule();
 }
 async function refresh(){
  if(!active||currentRead)return;
  const read=Symbol();currentRead=read;
  try{const next=await api('/api/app-update/status',{});if(currentRead===read)update(next);}
  catch(failure){if(currentRead===read){readError=failure?.message||'无法读取应用更新状态';render();}}
  finally{if(currentRead===read){currentRead=null;schedule();}}
 }
 async function run(action){
  if(busy||uncertainInstall||['launchUnknown','launched'].includes(status?.phase))return;
  const mine=generation;busy=action;error=null;confirmInstall=false;render();schedule();
  try{
   const result=action==='check'?await api('/api/app-update/check',{}):await mutate(`app-update/${action}`,{version:status.latest.version,...(action==='install'?{confirmed:true}:{})});
   if(mine===generation&&result?.currentVersion)update(result);
  }catch(failure){if(mine===generation){error=failure?.message||'应用更新失败';if(action==='install'&&failure?.outcome!=='notExecuted')uncertainInstall=true;}}
  finally{if(mine===generation){currentRead=null;busy=null;render();if(active)await refresh();}}
 }
 render();
 return {
  async activate(){
   active=true;render();await refresh();
   if(active&&status?.requiresRecheck&&['available','ready'].includes(status.phase))await run('check');
  },
  deactivate(){active=false;clearTimeout(timer);timer=null;confirmInstall=false;},
  refresh,update,
  get revision(){return revision;},
  reset(){generation++;revision++;currentRead=null;clearTimeout(timer);timer=null;status=null;error=null;readError=null;confirmInstall=false;uncertainInstall=false;busy=null;onStatus(null);render();if(active)refresh();},
 };
}
