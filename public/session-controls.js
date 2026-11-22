// Per-conversation overrides; never written to config.toml or browser storage.
import { icon } from './icons.js';
const isFastTier=tier=>tier==='priority'||tier==='fast';
function supportsFast(model){
 if(isFastTier(model?.defaultServiceTier))return true;
 if(Array.isArray(model?.serviceTiers)&&model.serviceTiers.length)return model.serviceTiers.some(tier=>isFastTier(tier?.id));
 if(Array.isArray(model?.additionalSpeedTiers))return model.additionalSpeedTiers.some(isFastTier);
 // Older catalogs omitted both fields. Keep accepting an explicit speed selection there.
 return !Array.isArray(model?.serviceTiers);
}
export function createSessionControls({document, defaults, threadId, model=()=>null, onFastChange, notice, permissionStore}) {
 const sessions=new Map();
 // New drafts start with automatic review; existing threads retain configuration inheritance.
 const draftKey=Symbol('draft');
 function session(id=threadId()||draftKey){
  if(!sessions.has(id))sessions.set(id,{permission:id===draftKey?'auto':null,fast:null,restore:false,scope:null,pending:null,revision:0,read:0,selection:0,stale:false});
  return sessions.get(id);
 }
 const current=()=>session();
 const chip=document.getElementById('permissions-info'), fast=document.getElementById('fast-toggle');
 function fastState(value=current(),config=defaults()){
  const selected=model(), supported=supportsFast(selected);
  const inherited=value.inheritedTier??config?.serviceTier??selected?.defaultServiceTier;
  return {supported,enabled:supported&&(value.fast??isFastTier(inherited))};
 }
 function modelChangeTier(){
  const speed=fastState();
  if(speed.enabled)return 'fast';
  return speed.supported&&current().fast===false?'default':null;
 }
 const menu=document.createElement('div');menu.className='permission-menu hidden';menu.id='permission-menu';menu.setAttribute('role','menu');
 chip.parentElement.append(menu);chip.setAttribute('aria-haspopup','menu');chip.setAttribute('aria-controls',menu.id);chip.setAttribute('aria-expanded','false');
 const choices=[['request','请求批准','需要额外权限时由你决定','lock'],['auto','帮我批准','由自动审查代理评估批准请求','shield'],['full','完全访问权限','无需批准，可访问沙箱外文件和网络','globe'],['custom','自定义 (config.toml)','沿用 config.toml 中定义的权限','settings']];
 const heading=document.createElement('div');heading.className='permission-menu-heading';heading.id='permission-menu-heading';heading.textContent='操作权限';menu.setAttribute('aria-labelledby',heading.id);menu.append(heading);
 const chipIcon=document.createElement('span');chipIcon.className='permission-chip-icon';chipIcon.setAttribute('aria-hidden','true');const oldChipIcon=chip.querySelector(':scope > .ui-icon, :scope > [data-icon]');if(oldChipIcon)oldChipIcon.replaceWith(chipIcon);else chip.prepend(chipIcon);
 // Display-only inference: reading a configuration never creates a turn override.
 function configuredMode(config){
  if(config?.approvalPolicy==='never'&&config?.sandbox==='danger-full-access'&&config?.approvalsReviewer==='user')return 'full';
  if(config?.approvalPolicy==='on-request'&&config?.sandbox==='workspace-write'&&(!config.sandboxPolicy||Object.keys(config.sandboxPolicy).every(key=>key==='type'))){if(config.approvalsReviewer==='user')return 'request';if(config.approvalsReviewer==='auto_review')return 'auto';}
  return 'custom';
 }
 function positionMenu(){
  const window=document.defaultView,rect=chip.getBoundingClientRect(),viewport=window.visualViewport;
  const left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,width=viewport?.width||document.documentElement.clientWidth,height=viewport?.height||window.innerHeight;
  menu.style.maxWidth=`${Math.max(0,width-16)}px`;menu.style.maxHeight=`${Math.max(0,height-16)}px`;
  menu.style.left=`${Math.max(left+8,Math.min(rect.left,left+width-menu.offsetWidth-8))}px`;
  menu.style.top=`${Math.max(top+8,Math.min(rect.top-menu.offsetHeight-10,top+height-menu.offsetHeight-8))}px`;
 }
 function close(focus=false){menu.classList.add('hidden');chip.setAttribute('aria-expanded','false');if(focus)chip.focus();}
 function render(){
  const value=current(), config=defaults(), unavailable=threadId()&&permissionStore&&(!value.scope||value.stale);
  const displayMode=value.permission||configuredMode(config), choice=choices.find(([id])=>id===displayMode);
  const label=value.pending?'正在保存':unavailable?'读取批准方式':displayMode==='custom'?'自定义':choice[1];
  chip.querySelector('.label').textContent=label;
  chipIcon.replaceChildren(icon(document,unavailable?'shield':choice[3],{size:15}));
  chip.title=unavailable?'正在确认此对话保存的批准方式':value.permission?label+' · 下一条消息生效':label+' · 继承 config.toml · '+(config?.approvalPolicy||'配置尚未完整读取');
  chip.dataset.warning=String(!unavailable&&displayMode==='full');
  const speed=fastState(value,config);
  fast.checked=speed.enabled;
  fast.disabled=!speed.supported;
  fast.title=speed.supported?'Fast 模式'+(speed.enabled?'已开启':'已关闭')+(value.fast===null?'（继承）':''):'当前模型不支持 Fast 模式';
  const trigger=document.getElementById('model-trigger');
  if(trigger){
   document.getElementById('model-trigger-fast').classList.toggle('hidden',!speed.enabled);
   const name=document.getElementById('model-trigger-name').textContent, speedLabel=speed.enabled?'Fast 模式已开启':'';
   trigger.setAttribute('aria-label',['模型与思考强度',name,document.getElementById('reasoning-label').textContent,speedLabel].filter(Boolean).join('，'));
   trigger.title=[document.getElementById('reasoning-model-name').title||name,speedLabel].filter(Boolean).join(' · ');
  }
  for(const button of menu.querySelectorAll('button'))button.setAttribute('aria-checked',String(!unavailable&&button.dataset.value===displayMode));
  if(!menu.classList.contains('hidden'))positionMenu();
 }
 function choose(mode){
  const id=threadId(), value=current();
  const selection=++value.selection;
  if(id&&permissionStore&&(!value.scope||value.stale&&!value.pending)){
   load(id).then(()=>{
    if(threadId()===id&&sessions.get(id)===value&&value.selection===selection&&value.scope&&!value.stale)choose(mode);
   }).catch(error=>notice('未能读取对话批准方式：'+error.message,true));
   return;
  }
  if(mode==='custom' && (!defaults()?.approvalPolicy||!defaults()?.sandbox)){
   notice('配置权限尚未完整读取，暂不能恢复自定义。请重新读取配置后再试。',true);return;
  }
  value.permission=mode;value.restore=mode==='custom';value.revision++;
  if(id && permissionStore){
   const scope=value.scope,revision=value.revision;
   const task=Promise.resolve(value.pending).then(async()=>{
    if(sessions.get(id)!==value)return;
    const saved=await permissionStore({threadId:id,scope,mode});
    if(saved?.scope!==scope||saved?.mode!==mode)throw new Error('保存回执与所选批准方式不符。');
   }).catch(error=>{
    if(sessions.get(id)!==value||value.revision!==revision)return;
    value.scope=null;value.permission=null;value.restore=false;
    notice('未能保存对话批准方式：'+error.message,true);
   });
   value.pending=task;task.finally(()=>{
    if(value.pending!==task)return;
    value.pending=null;
    if(id!==threadId()||sessions.get(id)!==value)return;
    render();
    if(!value.scope&&!value.stale)void load(id).catch(()=>{ /* The failed save is already reported. */ });
   });
  }
  render();close(true);
 }
 for(const [id,label,description,glyph] of choices){const button=document.createElement('button');button.type='button';button.dataset.value=id;button.setAttribute('role','menuitemradio');const content=document.createElement('span');content.className='permission-choice-copy';const title=document.createElement('span');title.className='permission-choice-title';title.textContent=label;const detail=document.createElement('small');detail.textContent=description;content.append(title,detail);const check=icon(document,'check',{size:18});check.classList.add('permission-choice-check');button.append(icon(document,glyph,{size:20}),content,check);if(id==='full')button.className='permission-danger';button.addEventListener('click',()=>choose(id));menu.append(button);}
 chip.addEventListener('click',()=>{const open=menu.classList.contains('hidden');menu.classList.toggle('hidden',!open);chip.setAttribute('aria-expanded',String(open));if(open){positionMenu();menu.querySelector('[aria-checked="true"]')?.focus();}});
 document.defaultView.addEventListener('resize',()=>close());document.defaultView.visualViewport?.addEventListener('resize',()=>close());
 menu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close(true);}if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=[...menu.querySelectorAll('button')];const index=buttons.indexOf(document.activeElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}});
 document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target)&&!chip.contains(event.target))close();});menu.addEventListener('focusout',event=>{if(!menu.contains(event.relatedTarget)&&event.relatedTarget!==chip)close();});
 fast.addEventListener('click',()=>{
  const speed=fastState();
  if(!speed.supported)return;
  current().fast=!speed.enabled;
  render();
  onFastChange?.(current().fast?'fast':'default');
 });
 function snapshot(id=threadId(),config=defaults()){const value=id?session(id):session(draftKey);if(id&&permissionStore&&!value.scope)throw new Error('正在读取对话批准方式，请稍后再试。');let permission=null;if(value.permission==='request'||value.permission==='auto')permission={approvalPolicy:'on-request',approvalsReviewer:value.permission==='auto'?'auto_review':'user',sandbox:'workspace-write',sandboxPolicy:{type:'workspaceWrite'}};if(value.permission==='full')permission={approvalPolicy:'never',approvalsReviewer:'user',sandbox:'danger-full-access',sandboxPolicy:{type:'dangerFullAccess'}};if(value.permission==='custom'&&value.restore){if(!config?.approvalPolicy||!config?.sandbox)throw new Error('无法还原配置权限；配置尚未完整读取。');permission={approvalPolicy:config.approvalPolicy,approvalsReviewer:config.approvalsReviewer||'user',sandbox:config.sandbox,sandboxPolicy:config.sandboxPolicy};}return structuredClone({permission,serviceTier:value.fast===null||!supportsFast(model())?null:value.fast?'fast':'default'});}
 function params(snapshot,kind){
  const result={};
  if(snapshot?.permission){
   const {approvalPolicy,approvalsReviewer,sandbox,sandboxPolicy}=snapshot.permission;
   if(!sandboxPolicy)throw new Error('配置中的沙箱策略无法安全还原，草稿已保留。');
   Object.assign(result,{approvalPolicy,approvalsReviewer},kind==='thread'?{sandbox}:{sandboxPolicy});
  }
  if(snapshot?.serviceTier)result.serviceTier=snapshot.serviceTier;
  return result;
 }
 function hydrate(value,stored){
  if(typeof stored?.scope!=='string'||(stored.mode!==null&&!choices.some(([mode])=>mode===stored.mode)))throw new Error('无法读取对话批准方式。');
  if(stored.warning){
   value.scope=null;value.permission=null;value.restore=false;
   notice(stored.warning,true);return;
  }
  value.scope=stored.scope;value.permission=stored.mode;value.restore=stored.mode==='custom';
 }
 async function load(id){
  if(!permissionStore)return;
  const value=session(id), revision=value.revision, read=++value.read;
  value.stale=true;
  if(id===threadId())render();
  await value.pending;
  const latest=()=>sessions.get(id)===value&&value.revision===revision&&value.read===read;
  try{
   const stored=await permissionStore({threadId:id});
   if(latest())hydrate(value,stored);
  }catch(error){
   if(latest()){value.scope=null;value.permission=null;value.restore=false;}
   throw error;
  }finally{if(latest()){value.stale=false;if(id===threadId())render();}}
 }
 function adopt(id){const draft=sessions.get(draftKey);if(draft)sessions.set(id,{...draft});sessions.delete(draftKey);render();}
 function restore(stored,serviceTier){if(stored)hydrate(current(),stored);if(serviceTier!==undefined)current().inheritedTier=serviceTier;close();render();}
 function reset(){sessions.clear();close();render();}
 function invalidate(){
  for(const [id,value] of sessions)if(id!==draftKey){value.stale=true;value.read++;}
  render();
 }
 async function changed({threadId:id,scope}={}){
  if(!sessions.has(id)||typeof scope!=='string')return;
  await load(id);
 }
 function confirmedSnapshot(id=threadId(),config=defaults()){
  if(id&&session(id).pending)throw new Error('正在保存对话批准方式，请稍后再发送。');
  if(id&&session(id).stale)throw new Error('正在同步此对话的批准方式，请稍后再发送。');
  return snapshot(id,config);
 }
 render();return {snapshot:confirmedSnapshot,params,adopt,restore,render,load,changed,invalidate,reset,modelChangeTier,mode:(id)=>session(id).permission};
}
