// Per-conversation overrides; never written to config.toml or browser storage.
import { icon } from './icons.js';
export function createSessionControls({document, defaults, threadId, notice}) {
 const sessions=new Map();
 const current=()=>{const id=threadId()||'draft';if(!sessions.has(id))sessions.set(id,{permission:null,fast:null,restore:false});return sessions.get(id);};
 const chip=document.getElementById('permissions-info'), fast=document.getElementById('fast-toggle');
 document.querySelector('.reasoning-heading')?.firstElementChild?.replaceWith(fast);
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
 function render(){const value=current(),config=defaults(),displayMode=value.permission||configuredMode(config);const choice=choices.find(([id])=>id===displayMode);const label=displayMode==='custom'?'自定义':choice[1];chip.querySelector('.label').textContent=label;chipIcon.replaceChildren(icon(document,choice[3],{size:15}));chip.title=value.permission?`${label} · 下一条消息生效`:`${label} · 继承 config.toml · ${config?.approvalPolicy||'配置尚未完整读取'}`;chip.dataset.warning=String(displayMode==='full');fast.setAttribute('aria-pressed',String(value.fast===null?config?.serviceTier==='fast':value.fast));fast.title=`Fast · ${value.fast===null?'继承配置':value.fast?'已开启':'已关闭，标准速度'} · 下一条消息生效`;for(const button of menu.querySelectorAll('button'))button.setAttribute('aria-checked',String(button.dataset.value===displayMode));if(!menu.classList.contains('hidden'))positionMenu();}
 for(const [id,label,description,glyph] of choices){const button=document.createElement('button');button.type='button';button.dataset.value=id;button.setAttribute('role','menuitemradio');const content=document.createElement('span');content.className='permission-choice-copy';const title=document.createElement('span');title.className='permission-choice-title';title.textContent=label;const detail=document.createElement('small');detail.textContent=description;content.append(title,detail);const check=icon(document,'check',{size:18});check.classList.add('permission-choice-check');button.append(icon(document,glyph,{size:20}),content,check);if(id==='full')button.className='permission-danger';button.addEventListener('click',()=>{const value=current();if(id==='custom'&&value.permission&&value.permission!=='custom'){const config=defaults();if(!config?.approvalPolicy||!config?.sandbox){notice('配置权限尚未完整读取，暂不能恢复自定义。请重新读取配置后再试。',true);return;}value.restore=true;}value.permission=id;render();close(true);});menu.append(button);}
 chip.addEventListener('click',()=>{const open=menu.classList.contains('hidden');menu.classList.toggle('hidden',!open);chip.setAttribute('aria-expanded',String(open));if(open){positionMenu();menu.querySelector('[aria-checked="true"]')?.focus();}});
 document.defaultView.addEventListener('resize',()=>close());document.defaultView.visualViewport?.addEventListener('resize',()=>close());
 menu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close(true);}if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=[...menu.querySelectorAll('button')];const index=buttons.indexOf(document.activeElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}});
 document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target)&&!chip.contains(event.target))close();});menu.addEventListener('focusout',event=>{if(!menu.contains(event.relatedTarget)&&event.relatedTarget!==chip)close();});
 fast.addEventListener('click',()=>{const value=current();value.fast=!(value.fast===null?defaults()?.serviceTier==='fast':value.fast);render();});
 function snapshot(){const value=current(),config=defaults();let permission=null;if(value.permission==='request'||value.permission==='auto')permission={approvalPolicy:'on-request',approvalsReviewer:value.permission==='auto'?'auto_review':'user',sandbox:'workspace-write',sandboxPolicy:{type:'workspaceWrite'}};if(value.permission==='full')permission={approvalPolicy:'never',approvalsReviewer:'user',sandbox:'danger-full-access',sandboxPolicy:{type:'dangerFullAccess'}};if(value.permission==='custom'&&value.restore){if(!config?.approvalPolicy||!config?.sandbox)throw new Error('无法还原配置权限；配置尚未完整读取。');permission={approvalPolicy:config.approvalPolicy,approvalsReviewer:config.approvalsReviewer||'user',sandbox:config.sandbox,sandboxPolicy:config.sandboxPolicy};}return structuredClone({permission,serviceTier:value.fast===null?null:value.fast?'fast':'default'});}
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
 function adopt(id){const draft=sessions.get('draft');if(draft)sessions.set(id,structuredClone(draft));sessions.delete('draft');render();}
 function restore(){close();render();}
 render();return {snapshot,params,adopt,restore,render};
}
