export function engineSetupDecision(snapshot){
 if(!snapshot?.supported||!snapshot?.needed)return {kind:'done'};
 const available=(snapshot.candidates||[]).filter(c=>c.available===true);
 if(available.length===1&&!snapshot.discoveryPending)return {kind:'automatic',candidate:available[0]};
 return {kind:snapshot.discoveryPending?'discover':available.length?'choose':'missing',available};
}

export function mountEngineOnboarding(host,{read,discover,complete,isLocal=()=>true,openSettings=()=>{},notice=()=>{}}){
 const doc=host.ownerDocument;
 const el=(tag,text,cls='')=>{const n=doc.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 const dialog=el('dialog',undefined,'engine-setup');dialog.setAttribute('aria-labelledby','engine-setup-heading');
 const content=el('div',undefined,'engine-setup-content');
 const eyebrow=el('p','开始使用码舱','engine-setup-eyebrow'),heading=el('h2','连接你的 Codex','engine-setup-heading');heading.id='engine-setup-heading';
 const intro=el('p','选择 Codex 所在的运行环境。登录、配置与对话保留在原环境中。','engine-setup-intro');
 const list=el('div',undefined,'engine-setup-options'),explanation=el('p','','engine-setup-explanation');
 const guide=el('a','查看官方 Codex 安装说明','engine-setup-guide');guide.href='https://github.com/openai/codex#installation';guide.target='_blank';guide.rel='noopener noreferrer';
 const live=el('p','','engine-setup-status');live.setAttribute('role','status');live.setAttribute('aria-live','polite');
 const actions=el('div',undefined,'engine-setup-actions');
 const later=el('button','稍后配置','btn'),settings=el('button','安装与配置','btn'),retry=el('button','重新检测','btn'),scan=el('button','完整检测 WSL','btn'),save=el('button','使用所选环境','btn primary');
 for(const b of [later,settings,retry,scan,save])b.type='button';
 actions.append(later,settings,retry,scan,save);content.append(eyebrow,heading,intro,list,explanation,guide,live,actions);dialog.append(content);host.append(dialog);
 let snapshot=null,busy=false,selected=null,finished=false,started=false,uncertain=false,previousFocus=null;
 const close=()=>{if(dialog.open)dialog.close();previousFocus?.focus?.();};
 const show=()=>{if(!dialog.open){previousFocus=doc.activeElement;dialog.showModal();}};
 function render(){
  const decision=engineSetupDecision(snapshot);list.replaceChildren();
  guide.hidden=decision.kind!=='missing';
  heading.textContent=decision.kind==='missing'?'还没有找到可用的 Codex':decision.kind==='choose'?'选择 Codex 运行环境':'连接你的 Codex';
  for(const candidate of snapshot?.candidates||[]){
   const row=el('label',undefined,'engine-setup-option');const radio=el('input');radio.type='radio';radio.name='engine-setup';radio.value=candidate.id;radio.checked=selected===candidate.id;radio.disabled=busy||!candidate.available||uncertain;
   radio.addEventListener('change',()=>{selected=candidate.id;render();});
   const copy=el('span',undefined,'engine-setup-copy');copy.append(el('strong',candidate.label),el('small',candidate.available?(candidate.version?`Codex ${candidate.version}`:'已检测到可用 Codex'):(candidate.diagnostic||'未检测到可用引擎，请检查安装与路径')));
   row.append(radio,copy);list.append(row);
  }
  explanation.textContent=snapshot?.nativeUnresolved?'Windows 引擎检测未完成。请重新检测；不会将超时视为未安装，也不会自动选择其他环境。':snapshot?.discoveryPending?'已自动检查正在运行的 WSL。有发行版未运行或尚未确认；手动检测可能启动它们，不调用模型。':decision.kind==='missing'?'可先安装官方 Codex CLI，或在设置中指定已有的 Windows / WSL 环境。安装后点击重新检测。':'之后可在「设置 → 通用 → Codex 运行环境」修改；选择不同环境需完全退出并重新打开，当前任务不会被切换。';
  if(snapshot?.diagnostic)explanation.append(el('span',String(snapshot.diagnostic),'engine-setup-diagnostic'));
  for(const b of [later,settings,retry,scan,save])b.disabled=busy;
  settings.hidden=decision.kind!=='missing'&&!snapshot?.diagnostic;
  scan.hidden=!snapshot?.discoveryPending||snapshot?.nativeUnresolved===true;save.hidden=!snapshot?.candidates?.some(c=>c.available);save.disabled=busy||uncertain||!selected;
  dialog.setAttribute('aria-busy',String(busy));
 }
 async function finish(input){
  if(busy||finished||!isLocal())return;busy=true;render();live.textContent='正在保存运行环境…';
  try{const result=await complete(input);if(!result?.completed)throw new Error('保存未确认，请重新检测');finished=true;close();notice(result.restartRequired?'环境已保存。完全退出并重新打开码舱后生效。':input.defer?'可随时在设置中配置 Codex 环境。':'已选用检测到的 Codex 运行环境。');}
  catch(e){uncertain=true;busy=false;await load(false,`运行环境未保存：${e.message}`);}
  finally{busy=false;render();}
 }
 async function load(scanning=false,saveMessage=''){
  if(busy||finished||!isLocal())return;busy=true;render();live.textContent=scanning?'正在检测 WSL 环境…':'正在检测 Windows 和已运行的 WSL…';
  try{const next=await(scanning?discover():read());if(!next||typeof next.needed!=='boolean'||typeof next.supported!=='boolean')throw new Error('运行环境状态无效');snapshot=next;
   const decision=engineSetupDecision(snapshot);if(decision.kind==='done'){finished=true;close();return;}
   selected=null;render();
   if(decision.kind==='automatic'&&!uncertain){busy=false;await finish({id:decision.candidate.id,automatic:true});return;}
   uncertain=false;show();live.textContent=saveMessage;
  }catch(e){show();live.textContent=`检测未完成：${e.message}。可以重试或稍后配置。`;}
  finally{busy=false;render();}
 }
 retry.addEventListener('click',()=>load());scan.addEventListener('click',()=>load(true));save.addEventListener('click',()=>finish({id:selected}));later.addEventListener('click',()=>finish({defer:true}));
 settings.addEventListener('click',()=>{if(busy)return;close();openSettings();});
 dialog.addEventListener('cancel',event=>{event.preventDefault();if(!busy)void finish({defer:true});});
 render();
 return {start(){if(started||!isLocal())return;started=true;void load();},refresh:()=>load(),element:dialog};
}



