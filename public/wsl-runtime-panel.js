// Explicit environment choice. Reading this panel never starts a WSL distribution.
// Discovery is opt-in; saving changes the next launch, never the active conversation.
export const runtimeTargetLabel = value => value?.target === 'wsl'
  ? `WSL · ${value.distribution || '未知发行版'}${value.user ? ` · ${value.user}` : ''}`
  : 'Windows 本机';
const key = value => JSON.stringify([value?.target || 'native', value?.distribution || '', value?.user || '']);
const selectionKey = value => key(value) + (value?.codexPath || '');
const message = error => String(error?.message || '请求失败，请重试。').slice(0,800);

export function mountWslRuntimePanel(host, { read, discover, select, isLocal = () => true }) {
  const doc = host.ownerDocument;
  const el = (tag, text, className = '') => { const node = doc.createElement(tag); node.className = className; if(text !== undefined)node.textContent = text; return node; };
  let active = false, generation = 0, busy = false, saving = false, snapshot = null, candidates = [], draft = null;
  const root = el('section', undefined, 'runtime-panel wsl-runtime-panel');
  const title = el('h2','Codex 运行环境','section-title');
  const intro = el('p','Windows 与 WSL 使用各自的 Codex 登录、配置和会话。切换不会复制或覆盖它们。','runtime-intro');
  const facts = el('div',undefined,'runtime-setting-rows');
  const controls = el('div',undefined,'wsl-runtime-controls');
  const label = el('label','下次启动使用','field');
  const picker = el('select');picker.setAttribute('aria-label','下次启动使用的 Codex 环境');label.append(picker);
  const pathLabel = el('label','Linux Codex 路径（可选）','field');
  const path = el('input');path.type='text';path.placeholder='/home/user/.nvm/versions/node/v24/bin/codex';path.autocomplete='off';path.spellcheck=false;path.setAttribute('aria-label','Linux Codex 绝对路径');pathLabel.append(path,el('small','留空自动检测。多个 nvm/fnm 版本并存时，可指定要使用的绝对路径。'));
  const actions = el('div',undefined,'runtime-actions');
  const refresh = el('button','刷新状态','btn');
  const scan = el('button','发现 WSL 中的 Codex','btn');
  const save = el('button','保存环境','btn primary');
  for(const b of [refresh,scan,save])b.type='button';
  actions.append(refresh,scan,save);controls.append(label,pathLabel,actions);
  const hint = el('p','发现会启动已安装的 WSL 发行版，以其默认 Linux 用户进行只读检查，不调用模型。请先在该用户下安装并登录 Codex。默认用户改变后需重新发现并选择。','runtime-intro');
  const status = el('p','','runtime-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  root.append(title,intro,facts,controls,hint,status);host.replaceChildren(root);
  const say = text => { status.textContent=text; };
  const row = (title,text) => { const node=el('div',undefined,'setting-row');const copy=el('div',undefined,'setting-row-copy');copy.append(el('strong',title),el('p',text));node.append(copy);return node; };
  function targets(){
    const values=[{target:'native'},...candidates.map(c=>({target:'wsl',distribution:c.distribution,user:c.user}))];
    for(const item of [snapshot?.selected,draft])if(item?.target==='wsl'&&!values.some(v=>key(v)===key(item)))values.push(item);
    return values;
  }
  function canSave(){
    if(busy||!isLocal()||!snapshot?.canSelect||!draft||selectionKey(draft)===selectionKey(snapshot.selected))return false;
    if(draft.target!=='wsl')return true;
    if(draft.codexPath)return draft.codexPath.startsWith('/')&&!/[\r\n\0]/.test(draft.codexPath);
    return candidates.some(c=>key({...c,target:'wsl'})===key(draft)&&c.available);
  }
  function render(){
    const local=isLocal();root.hidden=!local || snapshot?.supported===false;
    root.setAttribute('aria-busy',String(busy));
    facts.replaceChildren();
    if(snapshot){
      facts.append(row('当前运行',runtimeTargetLabel(snapshot.current)),row('下次启动',runtimeTargetLabel(snapshot.selected)));
      if(snapshot.current.target==='wsl'&&snapshot.engineVersion)facts.append(row('当前引擎版本',String(snapshot.engineVersion)));
      if(snapshot.restartRequired)facts.append(row('重启后生效','环境已保存。请先完成当前任务，再完全退出并重新打开码舱；最小化到托盘不会切换环境。'));
      if(snapshot.current.target==='wsl'||snapshot.selected.target==='wsl')facts.append(row('WSL 引擎更新','在所选发行版内使用原安装方式更新 Linux Codex CLI，例如该 Linux 用户自己的 npm。'));
      for(const limitation of snapshot.limitations||[])facts.append(row('兼容提示',String(limitation)));
      for(const candidate of candidates)facts.append(row(`${candidate.distribution} · ${candidate.user || '默认用户'}`,candidate.available ? `${candidate.codexPath || '已找到 Codex'}${candidate.codexHome ? ` · 配置：${candidate.codexHome}` : ''}` : candidate.diagnostic || '未发现可用 Codex。请在此发行版内检查安装与 PATH。'));
    }
    picker.replaceChildren();
    for(const target of targets()){const option=el('option',runtimeTargetLabel(target));option.value=key(target);picker.append(option);}
    picker.value=key(draft||snapshot?.selected);
    pathLabel.hidden=draft?.target!=='wsl';path.value=draft?.codexPath||'';path.disabled=busy||!local||!snapshot?.canSelect;
    const allowed=local&&snapshot?.canSelect===true;
    picker.disabled=busy||!allowed;refresh.disabled=busy||!local;scan.disabled=busy||!allowed;
    save.disabled=!canSave();
  }
  async function load(scanning=false){
    if(busy||!active||!isLocal())return;
    const mine=++generation;busy=true;render();say(scanning?'正在发现 WSL 环境…':'正在读取运行环境…');
    try{
      const next=await(scanning?discover():read());if(mine!==generation||!active||!isLocal())return;
      if(!next||typeof next.supported!=='boolean'||!next.current||!next.selected)throw new Error('运行环境状态格式无效');
      snapshot=next;draft=next.selected;
      if(scanning)candidates=Array.isArray(next.candidates)?next.candidates:[];
      say(scanning?(candidates.some(c=>c.available)?'发现完成。请选择环境并保存；当前会话不会切换。':'未发现可用的 WSL Codex。原来的运行环境没有改变。'):'');
    }catch(error){if(mine===generation){snapshot=null;say(message(error));}}
    finally{if(mine===generation){busy=false;render();}}
  }
  async function saveSelection(){
    if(!active||!canSave())return;
    const mine=++generation;const target={...draft};if(!target.codexPath)delete target.codexPath;busy=true;saving=true;render();say('正在保存下次启动的环境…');
    try{
      const next=await select(target);if(mine!==generation||!active||!isLocal())return;
      if(!next?.selected||next.selected.target!==target.target||next.selected.distribution!==target.distribution||(target.user&&next.selected.user!==target.user)||(next.selected.codexPath||'')!==(target.codexPath||''))throw new Error('保存结果与选择不一致，请刷新状态核对。');
      snapshot=next;draft=next.selected;say(next.restartRequired?'已保存，完全退出并重新打开码舱后生效。当前任务保持原环境。':'已保存。');
    }catch(error){if(mine===generation){snapshot={...snapshot,canSelect:false};say(`保存结果未确认：${message(error)} 请刷新状态核对，不会自动重试保存。`);}}
    finally{saving=false;if(mine===generation){busy=false;render();}else if(active){busy=false;void load();}}
  }
  picker.addEventListener('change',()=>{draft=targets().find(value=>key(value)===picker.value)||snapshot?.selected;pathLabel.hidden=draft?.target!=='wsl';path.value=draft?.codexPath||'';save.disabled=!canSave();});
  path.addEventListener('input',()=>{if(draft?.target!=='wsl')return;draft={...draft};if(path.value.trim())draft.codexPath=path.value.trim();else delete draft.codexPath;save.disabled=!canSave();});
  refresh.addEventListener('click',()=>load());scan.addEventListener('click',()=>load(true));save.addEventListener('click',saveSelection);
  render();
  return {
    setActive(value){const next=!!value&&isLocal();if(next===active)return;active=next;if(!active){generation++;busy=saving;return;}if(!saving){busy=false;void load();}},
    reset(){generation++;snapshot=null;candidates=[];draft=null;busy=saving;render();if(active&&!saving)void load();},
  };
}
