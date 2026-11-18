// DSH MCP connection entry (local only). One explicit click runs plan → connect against the
// bundled bridge. Three facts stay separate and truthful: the user-config registration, the
// queued MCP reload, and the actual runtime status reported by mcpServerStatus/list.
// An existing external dsh_subagent entry is never replaced; there is no "replace" path.
import { el } from './format.js';
import { icon } from '../icons.js';
import { dshRuntimeStatusLabel } from '../dsh.js';

const SETTLED = new Set(['connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled']);
// Errors the backend reports before any write; everything else from connect may have written.
const NOT_EXECUTED = new Set(['INVALID_INPUT', 'CONFIRMATION_REQUIRED', 'PLAN_EXPIRED', 'CONNECTION_ALREADY_ATTEMPTED', 'CONNECTION_BUSY', 'MCP_ALREADY_CONFIGURED', 'REVISION_CONFLICT', 'CODEX_CONFIG_READONLY', 'DSH_COMPONENT_UNAVAILABLE', 'DSH_DEMO_DISABLED', 'TOO_MANY_PLANS', 'LOCAL_ONLY']);
const runtimeTone = state => state === 'connected' ? 'ok' : ['failed', 'authenticationRequired', 'cancelled', 'disabled'].includes(state) ? 'fail' : 'warn';

export function describeCallbackStatus(callback) {
  if (!callback || typeof callback !== 'object') return null;
  const error = typeof callback.error === 'string' ? callback.error : callback.error?.message;
  if (error) return `自动唤醒暂停：${String(error).slice(0,1000)}`;
  if (callback.accountVerified !== true) return '自动唤醒暂停：尚未核对当前账户，不能确认可以投递。';
  if (callback.automaticWakeup !== true) return '自动唤醒未启用；可通过 dsh_wait 主动读取任务结果。';
  const count = Number.isSafeInteger(callback.pendingBindings) && callback.pendingBindings >= 0 ? callback.pendingBindings : null;
  return `自动唤醒已启用，当前账户已核对${count === null ? '' : `；待处理绑定 ${count} 个`}。任务是否已投递仍以实际结果为准。`;
}

/** Status (+ optional connect result) → banner and allowed action. Pure for tests. */
export function describeConnection(status, result = null) {
  if (!status) return { tone: 'idle', label: '尚未读取', detail: '', action: null };
  if (status.selectionRequired) return { tone: 'idle', label: '选择 DSH 所在环境', detail: '先选择 WSL 原生 DSH 或 Windows DSH。仅检查状态，不会自动注册。', action: null };
  const reg = status.registration?.state, runtime = status.runtime?.state ?? null, runtimeLabel = dshRuntimeStatusLabel(runtime);
  if (status.error) return { tone: 'fail', label: '不可用', detail: `${status.error.message || status.error.code}。仅影响此连接功能，普通聊天不受影响。`, action: null };
  if (reg === 'external') return { tone: runtime === 'connected' ? 'ok' : 'warn', label: '使用已有配置', detail: `Codex 中已有名为 ${status.registration.serverName} 的 MCP 配置，已保留并继续使用，不会改成随包桥。运行时：${runtimeLabel}。`, action: null };
  if (reg === 'bundled') {
    const label = runtime === 'connected' ? '已连接' : SETTLED.has(runtime) ? runtimeLabel : '已注册，尚未确认连接';
    const pending = result && !result.reload?.queued ? '此客户端未完成 MCP 刷新，请重新打开会话后再检查。' : '已注册不等于已连接；连接状态以 Codex 实际返回为准。';
    return { tone: runtimeTone(runtime), label, detail: runtime === 'connected' ? '随包桥已在 Codex 中注册并连接。' : `随包桥已注册到 Codex 用户配置。${pending}`, action: null };
  }
  if (reg === 'unknown') return { tone: 'fail', label: '状态未知', detail: '无法确认现有 MCP 配置，暂不提供连接。', action: null };
  const bundled = status.bundled || {};
  if (!bundled.available || !bundled.dependenciesReady) return { tone: 'fail', label: '随包桥不可用', detail: '随包 DSH 桥或其依赖未就绪。不会联网下载；普通聊天不受影响。', action: null };
  if (!status.canConnect) return { tone: 'fail', label: '暂不可连接', detail: 'Codex 用户配置当前不可写或不兼容。', action: null };
  return { tone: 'idle', label: '未连接', detail: status.dsh?.diagnostic?.message ? String(status.dsh.diagnostic.message).slice(0,1000) : status.dsh?.installed ? '已检测到 DSH，可一键连接。' : '未检测到 DSH 本体。DSH 是可选组件，未安装不影响普通聊天；已安装在其他位置可填写其路径。', action: status.dsh?.installed ? 'connect' : 'connectWithPath' };
}

export function mountDshConnection(host, { api, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), followUps = 5, followUpMs = 2000, onChange = () => {}, onModelSaved = () => {}, runtimeTarget = () => 'native' }) {
  const document = host.ownerDocument;
  let status = null, result = null, busy = false, connecting = false, generation = 0, pathDraft = '', message = { text: '', error: false };
  let mode = null, context = runtimeTarget();
  const root = el(document, 'section', 'dshcfg dshconn');
  host.replaceChildren(root);

  async function load(mine = ++generation) {
    busy = true; render();
    try { const next = await api('/api/dsh/connection/status', mode ? { mode } : {}); if (mine !== generation) return; status = next; }
    catch (error) { if (mine !== generation) return; status = null; message = { text: `无法读取连接状态：${error.message}`, error: true }; }
    finally { if (mine === generation) { busy = false; render(); } }
  }
  // After a registration, follow the real runtime status for a bounded time; never infer it.
  async function follow(mine) {
    for (let round = 0; round < followUps; round++) {
      if (mine !== generation || SETTLED.has(status?.runtime?.state) || status?.registration?.state !== 'bundled') return;
      await wait(followUpMs); if (mine !== generation) return;
      await load(mine);
    }
  }
  async function connect() {
    if (connecting || busy || !describeConnection(status).action) return;
    const executablePath = pathDraft.trim();
    const mine = ++generation; connecting = true; busy = true; result = null; message = { text: '正在注册…', error: false }; render();
    let planned = false;
    try {
      const plan = await api('/api/dsh/connection/plan', { ...(mode ? { mode } : {}), ...(executablePath && !status?.dsh?.installed ? { executablePath } : {}) });
      planned = true;
      result = await api('/api/dsh/connection/connect', { planId: plan.planId, confirmed: true });
      if (mine !== generation) return;
      message = { text: result.warning || (result.reload?.queued ? '已注册，MCP 刷新已排队；正在等待 Codex 报告实际连接状态。' : '已注册。'), error: !!result.warning };
      onChange();
    } catch (error) {
      if (mine !== generation) return;
      const unknown = planned && !NOT_EXECUTED.has(error.code) && error.outcome !== 'notExecuted';
      message = { text: unknown ? `连接结果未知：${error.message}。已重新读取状态，请核对后再操作；不会自动重发。` : error.code === 'MCP_ALREADY_CONFIGURED' ? `${error.message}。现有配置可继续使用。` : error.message, error: true };
    } finally {
      connecting = false;
      if (mine === generation) { busy = false; await load(mine); follow(mine); }
    }
  }

  function header() {
    const head = el(document, 'div', 'dshcfg-head');
    const titles = el(document, 'div');
    titles.append(el(document, 'h2', 'section-title', 'DSH MCP 连接'), el(document, 'p', 'fine', '码舱 CodeCang 自带 DSH MCP 桥。连接后 Codex 可调用 DSH 子代理；不连接也可以正常聊天。'));
    const reload = el(document, 'button', 'btn icon-only ghost'); reload.type = 'button'; reload.setAttribute('aria-label', '重新检查连接'); reload.title = '重新检查连接';
    reload.append(icon(document, 'refresh', { size: 16 })); reload.disabled = busy;
    reload.addEventListener('click', () => { message = { text: '', error: false }; load(); });
    head.append(titles, reload);
    return head;
  }
  function modePicker() {
    const field = el(document, 'label', 'field', 'DSH 所在环境');
    const picker = el(document, 'select');picker.setAttribute('aria-label', 'DSH 所在环境');picker.disabled = busy || connecting;
    for(const [value,label] of [['','请选择'],['native-wsl','WSL 原生 DSH'],['windows','Windows DSH']]){const option=el(document,'option','',label);option.value=value;picker.append(option);}
    picker.value=mode||'';
    picker.addEventListener('change',()=>{if(busy||connecting)return;mode=picker.value||null;status=null;result=null;pathDraft='';message={text:'',error:false};load();});
    field.append(picker,el(document,'small','','选择只用于检查和本次注册计划，不会覆盖已有 MCP 配置。'));
    return field;
  }
  function facts(view) {
    const list = el(document, 'dl', 'kv dshcfg-effective');
    const fact = (k, v) => list.append(el(document, 'dt', '', k), el(document, 'dd', '', v));
    const bundled = status.bundled || {};
    fact('DSH 本体', status.dsh?.installed ? status.dsh.executablePath : status.dsh?.diagnostic?.message ? '自动检测未就绪，可填写路径重试' : '未检测到（可选）');
    if(status.dsh?.diagnostic?.message)fact('检测说明',String(status.dsh.diagnostic.message).slice(0,1000));
    if(status.dsh?.workspaceSupport==='windows-drives-only')fact('工作目录','仅 Windows 盘项目（/mnt/c/... 等）；不支持 Linux /home 等目录。');
    if(status.dsh?.completionMode==='dsh_wait'||status.capabilities?.completionMode==='dsh_wait')fact('任务结果','通过 dsh_wait 等待并读取结果。');
    const callbackLabel=describeCallbackStatus(status.callbackStatus);
    if(callbackLabel)fact('自动唤醒',callbackLabel);
    else if(status.dsh?.automaticWakeup===false||status.capabilities?.automaticWakeup===false)fact('自动唤醒','此连接模式不支持完成后自动唤醒；请等待或主动读取任务结果。');
    else if(status.capabilities?.automaticWakeup===true)fact('自动唤醒','支持此能力，但尚未读取实际回调状态，不能确认可以投递。');
    fact('随包桥', bundled.available ? `${bundled.version || '版本未知'} · ${bundled.dependenciesReady ? '依赖就绪' : '依赖缺失'}` : '不可用');
    fact('注册', ({ none: '未注册', bundled: `已注册（随包桥 · ${status.registration?.serverName}）`, external: `已有外部配置（${status.registration?.serverName}，已保留）`, unknown: '未知' })[status.registration?.state] || '未知');
    if (result) fact('MCP 刷新', result.reload?.queued ? '已排队（不等于已连接）' : `未完成：${result.reload?.error?.message || '客户端不支持'}`);
    if (status.registration?.state === 'bundled' || status.registration?.state === 'external') fact('运行时', dshRuntimeStatusLabel(status.runtime?.state ?? null));
    return list;
  }
  function actions(view) {
    const panel = el(document, 'div', 'panel dshconn-action');
    panel.append(el(document, 'p', 'fine', `将在 Codex 用户配置中添加 mcp_servers.${status.registration?.serverName || 'dsh_subagent'}，指向随包桥与 DSH 本体；只写这一项，不覆盖已有配置，不发送模型请求。`));
    const row = el(document, 'div', 'dshcfg-register');
    let input = null;
    if (view.action === 'connectWithPath') {
      input = el(document, 'input'); input.placeholder = mode === 'native-wsl' ? '/home/user/应用/DeepSeek Harness 的绝对路径' : 'DeepSeek Harness.exe 的绝对路径'; input.setAttribute('aria-label', 'DSH 程序路径'); input.autocomplete = 'off'; input.spellcheck = false; input.value = pathDraft; input.disabled = busy;
      input.addEventListener('input', () => { pathDraft = input.value; button.disabled = busy || connecting || !pathDraft.trim(); });
      row.append(icon(document, 'file', { size: 16 }), input);
    }
    const button = el(document, 'button', 'btn primary', connecting ? '正在连接…' : '连接 DSH'); button.type = 'button';
    button.disabled = busy || connecting || (view.action === 'connectWithPath' && !pathDraft.trim());
    button.addEventListener('click', connect);
    row.append(button); panel.append(row);
    return panel;
  }
  function modelSettings() {
    const panel = el(document, 'section', 'panel dsh-default-model');
    panel.append(el(document, 'h3', 'section-title', '子代理默认模型'));
    const defaults = status.modelDefaults;
    if (!defaults.available) {
      panel.append(el(document, 'p', 'inline-error', defaults.error || '暂时无法读取模型设置。'));
      return panel;
    }
    if (status.registration?.state === 'external') {
      panel.append(el(document, 'p', 'fine', '当前使用外部 MCP 桥，请在该桥的模型设置中修改。下面的选择用于码舱随包桥。'));
    } else {
      panel.append(el(document, 'p', 'fine', '通过 DeepSeek Harness 新建子代理时使用。单次任务指定的模型优先。'));
    }
    const form = el(document, 'form', 'dsh-default-fields');
    function field(title, placeholder, value, maxLength) {
      const label = el(document, 'label', 'field', title);
      const input = el(document, 'input');
      Object.assign(input, {value:value || '', placeholder, maxLength, autocomplete:'off', spellcheck:false});
      label.append(input); form.append(label); return input;
    }
    const model = field('模型 ID', '例如 deepseek-flash', defaults.selection?.model, 255);
    const provider = field('提供商 ID（可选）', '使用 DSH 的默认提供商', defaults.selection?.provider, 100);
    model.required = true;
    const row = el(document, 'div', 'actions');
    const submit = el(document, 'button', 'btn primary', '保存默认模型'); submit.type = 'submit';
    const reset = el(document, 'button', 'btn ghost', '恢复 DSH 默认值'); reset.type = 'button';
    reset.disabled = !defaults.selection;
    const feedback = el(document, 'p', 'fine'); feedback.setAttribute('role', 'status');
    let saving = false;
    async function save(selection) {
      if (saving) return;
      saving = true; submit.disabled = true; reset.disabled = true;
      const target = status, currentMode = mode;
      try {
        const next = await api('/api/dsh/connection/saveModel', {...(currentMode ? {mode:currentMode} : {}), selection});
        target.modelDefaults = next;
        model.value = next.selection?.model || ''; provider.value = next.selection?.provider || '';
        feedback.className = 'fine'; feedback.textContent = next.selection ? '已保存，下次新建子代理时生效。' : '已恢复 DSH 默认值。';
        onModelSaved();
      } catch (error) { feedback.className = 'inline-error'; feedback.textContent = error.message; }
      finally { saving = false; submit.disabled = false; reset.disabled = !target.modelDefaults.selection; }
    }
    form.addEventListener('submit', event => { event.preventDefault(); save({model:model.value.trim(), ...(provider.value.trim() ? {provider:provider.value.trim()} : {})}); });
    reset.addEventListener('click', () => save(null));
    row.append(submit, reset); form.append(row); panel.append(form,feedback); return panel;
  }
  function render() {
    root.replaceChildren(header());
    if(context==='wsl'||status?.selectionRequired||mode)root.append(modePicker());
    if(mode==='windows'&&(context==='wsl'||status?.mode==='windows'))root.append(el(document,'p','runtime-blocked','WSL 调用 Windows DSH 仅支持 Windows 盘项目（例如 /mnt/c/...）。Linux /home 等原生目录不可用；请改用 WSL 原生 DSH，或选择 Windows 盘项目。'));
    if (!status) { root.append(el(document, 'p', 'empty-line', busy ? '正在检查…' : '尚未检查')); appendMessage(); return; }
    if(status.selectionRequired){root.append(el(document,'p','fine',describeConnection(status).detail));appendMessage();return;}
    const view = describeConnection(status, result);
    if (status.modelDefaults) root.append(modelSettings());
    const box = el(document, 'div', 'dshcfg-activation'); box.dataset.tone = view.tone; box.setAttribute('role', 'status');
    const line = el(document, 'div', 'dshcfg-activation-line'); line.append(el(document, 'span', 'agent-state', view.label));
    box.append(line, el(document, 'p', '', view.detail), facts(view));
    root.append(box);
    for(const limitation of status.limitations||[])root.append(el(document,'p','runtime-blocked',String(limitation)));
    if (view.action) root.append(actions(view));
    appendMessage();
  }
  function appendMessage() { if (!message.text) return; const p = el(document, 'p', message.error ? 'inline-error' : 'fine', message.text); p.setAttribute('role', 'status'); root.append(p); }
  render();
  return {
    activate() { if(context!==runtimeTarget()){context=runtimeTarget();mode=null;status=null;result=null;pathDraft='';} message = { text: '', error: false }; load(); },
    // Leaving the page stops follow-ups; an in-flight connect still finishes server-side and is re-read on return.
    deactivate() { generation++; busy = connecting; },
    snapshot: () => ({ status, result, busy, connecting }),
  };
}
