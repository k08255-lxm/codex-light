// DSH provider config sources (local only). Lets the user choose which profile / custom
// cordis.patch.yml files feed the DSH bridge, and whether new runtimes follow source changes.
// Truthful states: saving configures the NEXT runtime; running/reused runtimes keep their version,
// and `pendingRestart` means the running bridge has not loaded this capability yet.
import { el } from './format.js';
import { icon } from '../icons.js';

const ACTIVATION = {
  active: { tone: 'ok', label: '已启用', detail: '新建的 DSH runtime 会使用下方的有效快照；正在运行或被复用的 runtime 保留原配置。' },
  pendingRestart: { tone: 'warn', label: '待重启生效', detail: '设置已保存，但当前运行的 DSH 桥尚未加载此功能。重启 DSH 桥后，新建的 runtime 才会使用这些来源；现有任务不受影响。' },
  unavailable: { tone: 'fail', label: '不可用', detail: '当前 DSH 桥不支持配置来源管理。' },
};
const MAX_SOURCES = 8;
const shortHash = value => typeof value === 'string' && value ? value.slice(0, 10) : '—';
const when = iso => { const d = new Date(iso || ''); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };

/** Selection draft → configure body. Pure, so the constraints are testable. An empty selection is valid: built-in providers only. */
export function configureBody(status, draft) {
  const ids = [...draft.selected].filter(id => status?.sources?.some(source => source.id === id));
  if (ids.length > MAX_SOURCES) return { error: `最多选择 ${MAX_SOURCES} 个来源` };
  const invalid = status.sources.filter(source => ids.includes(source.id) && !source.valid);
  if (invalid.length) return { error: `所选来源无效：${invalid.map(source => source.label || source.id).join('、')}` };
  return { body: { sourceIds: ids, autoFollow: !!draft.autoFollow, expectedRevision: status.revision } };
}
/** What the next runtime will use, from the saved effective snapshot (or the selection when none exists yet). */
export function effectiveMode(status) {
  const mode = status?.effective?.mode;
  if (mode === 'builtin' || mode === 'imports') return mode;
  if (status?.effective) return (status.effective.sourceIds || []).length ? 'imports' : 'builtin';
  return (status?.selectedSourceIds || []).length ? 'imports' : 'builtin';
}
/** Providers declared by more than one selected source (backend decides if content differs). */
export function sharedProviders(status, selected) {
  const seen = new Map();
  for (const source of status?.sources || []) if (selected.has(source.id)) for (const provider of source.providers || []) seen.set(provider.id, [...(seen.get(provider.id) || []), source.label || source.id]);
  return [...seen].filter(([, owners]) => owners.length > 1).map(([id, owners]) => ({ id, owners }));
}

export function mountDshConfig(host, { api }) {
  const document = host.ownerDocument;
  let status = null, draft = null, busy = false, generation = 0, message = { text: '', error: false };

  const root = el(document, 'section', 'dshcfg');
  host.replaceChildren(root);
  const say = (text, error = false) => { message = { text, error }; render(); };

  function resetDraft() { draft = { selected: new Set(status?.selectedSourceIds || []), autoFollow: !!status?.autoFollow }; }
  const dirty = () => !!status && !!draft && (draft.autoFollow !== !!status.autoFollow || draft.selected.size !== (status.selectedSourceIds || []).length || [...draft.selected].some(id => !status.selectedSourceIds.includes(id)));

  async function call(path, body, done) {
    const mine = ++generation; busy = true; render();
    try { const result = await api(path, body); if (mine !== generation) return; status = result; resetDraft(); if (done) message = { text: done, error: false }; }
    catch (error) {
      if (mine !== generation) return;
      // Known not-executed errors (409 revision/provider conflict, 400, 503) are shown as-is; nothing is retried.
      const hint = error.code === 'SOURCE_CONFLICT' ? '（同一 provider 在所选来源中内容不同，请只保留其一）' : /revision/i.test(error.code || '') ? '（配置已在别处变更，已重新读取，请检查后再保存）' : '';
      message = { text: `${error.message}${hint}`, error: true };
      if (/revision/i.test(error.code || '')) { busy = false; await load(); return; }
    } finally { if (mine === generation) { busy = false; render(); } }
  }
  const load = () => call('/api/dsh/config-sources/status', {});

  function header() {
    const head = el(document, 'div', 'dshcfg-head');
    const titles = el(document, 'div');
    titles.append(el(document, 'h2', 'section-title', 'DSH 配置来源'), el(document, 'p', 'fine', 'DSH 默认使用内置 provider。可额外选择导入哪些 profile 或自定义 cordis.patch.yml，只导入其中的 provider 声明，不修改源文件，不返回密钥。'));
    const reload = el(document, 'button', 'btn icon-only ghost'); reload.type = 'button'; reload.setAttribute('aria-label', '重新读取状态'); reload.title = '重新读取状态'; reload.append(icon(document, 'refresh', { size: 16 }));
    reload.disabled = busy; reload.addEventListener('click', () => { message = { text: '', error: false }; load(); });
    head.append(titles, reload);
    return head;
  }
  function activationBanner() {
    const state = ACTIVATION[status.activation?.state] || ACTIVATION.unavailable;
    const box = el(document, 'div', 'dshcfg-activation'); box.dataset.tone = state.tone; box.setAttribute('role', 'status');
    const line = el(document, 'div', 'dshcfg-activation-line');
    line.append(el(document, 'span', 'agent-state', state.label), el(document, 'span', 'fine', status.policy === 'new-runtime-only' ? '仅影响之后新建的 runtime' : ''));
    box.append(line, el(document, 'p', '', state.detail));
    if (status.drift) box.append(el(document, 'p', 'dshcfg-warn', status.autoFollow ? '来源文件已变化：下一个新 runtime 创建前会重新读取。' : '来源文件已变化，但自动跟随已关闭：新 runtime 仍使用冻结快照，点击“立即更新快照”采用新内容。'));
    if (status.error) box.append(el(document, 'p', 'inline-error', status.error.message || String(status.error)));
    const eff = status.effective;
    const mode = effectiveMode(status);
    const facts = el(document, 'dl', 'kv dshcfg-effective');
    const fact = (k, v) => facts.append(el(document, 'dt', '', k), el(document, 'dd', 'mono', v));
    fact('使用的模型来源', mode === 'builtin' ? '仅 DSH 内置 provider（不额外导入）' : '内置 provider + 所选来源导入');
    fact('有效快照', eff ? shortHash(eff.revision) : '尚未生成');
    if (eff) { fact('生成时间', when(eff.generatedAt)); if (mode === 'imports') fact('来源 / Provider', `${(eff.sourceIds || []).length} 个来源 · ${eff.providerCount ?? '—'} 个导入 provider`); }
    box.dataset.mode = mode;
    box.append(facts);
    return box;
  }
  function builtinRow() {
    // Explicit "built-in only" choice: an empty selection, saved like any other.
    const row = el(document, 'li', 'dshcfg-source dshcfg-builtin'); row.dataset.valid = 'true';
    const label = el(document, 'label', 'dshcfg-pick');
    const box = el(document, 'input'); box.type = 'radio'; box.name = 'dshcfg-builtin'; box.checked = draft.selected.size === 0; box.disabled = busy;
    box.setAttribute('aria-describedby', 'dshcfg-builtin-detail');
    box.addEventListener('change', () => { if (box.checked) { draft.selected.clear(); message = { text: '', error: false }; render(); } });
    const text = el(document, 'div', 'dshcfg-source-text');
    const name = el(document, 'div', 'dshcfg-source-name'); name.append(el(document, 'strong', '', '仅使用 DSH 内置模型'), el(document, 'span', 'plan-badge', '内置'));
    const detail = el(document, 'div', 'fine', '不导入任何第三方 provider 配置；无需先添加私人 provider。勾选下方任一来源即改为同时导入该来源。'); detail.id = 'dshcfg-builtin-detail';
    text.append(name, detail); label.append(box, text); row.append(label);
    return row;
  }
  function sourceRow(source) {
    const row = el(document, 'li', 'dshcfg-source'); row.dataset.valid = String(!!source.valid);
    const label = el(document, 'label', 'dshcfg-pick');
    const box = el(document, 'input'); box.type = 'checkbox'; box.checked = draft.selected.has(source.id); box.disabled = busy || (!source.valid && !box.checked);
    box.setAttribute('aria-describedby', 'dshcfg-src-' + source.id.replace(/[^\w-]/g, '_'));
    box.addEventListener('change', () => { if (box.checked) draft.selected.add(source.id); else draft.selected.delete(source.id); message = { text: '', error: false }; render(); });
    const text = el(document, 'div', 'dshcfg-source-text');
    const name = el(document, 'div', 'dshcfg-source-name');
    name.append(el(document, 'strong', '', source.label || source.id), el(document, 'span', 'plan-badge', source.kind === 'profile' ? 'profile' : source.kind === 'desktop' ? '桌面' : '自定义'));
    if (!source.valid) { const bad = el(document, 'span', 'agent-state', '无效'); bad.dataset.tone = 'fail'; name.append(bad); }
    const path = el(document, 'div', 'dshcfg-path mono', source.path || ''); path.title = source.path || '';
    const meta = el(document, 'div', 'fine'); meta.id = 'dshcfg-src-' + source.id.replace(/[^\w-]/g, '_');
    meta.textContent = source.valid ? `${(source.providers || []).length} 个 provider · 修改于 ${when(source.modifiedAt)} · ${shortHash(source.hash)}` : (source.error?.message || '无法读取或校验');
    text.append(name, path, meta);
    if (source.valid && source.providers?.length) {
      const list = el(document, 'ul', 'dshcfg-providers');
      for (const provider of source.providers.slice(0, 12)) { const li = el(document, 'li'); li.append(el(document, 'span', 'mono', provider.id), el(document, 'span', 'fine', `${provider.api || ''}${provider.baseURL ? ' · ' + provider.baseURL : ''} · ${provider.modelCount ?? '—'} 个模型`)); list.append(li); }
      text.append(list);
    }
    label.append(box, text); row.append(label);
    return row;
  }
  function render() {
    root.replaceChildren(header());
    if (!status) { root.append(el(document, 'p', 'empty-line', busy ? '正在读取…' : '尚未读取')); appendMessage(); return; }
    if (!status.available) { root.append(el(document, 'p', 'empty-line', status.error?.message || '未检测到已安装的 DSH 桥。')); appendMessage(); return; }
    root.append(activationBanner());
    const list = el(document, 'ul', 'dshcfg-sources');
    list.append(builtinRow());
    for (const source of status.sources || []) list.append(sourceRow(source));
    if (!(status.sources || []).length) list.append(el(document, 'li', 'empty-line', '没有发现 profile。可只使用内置模型，或在下方注册自定义 cordis.patch.yml。'));
    root.append(list);
    const shared = sharedProviders(status, draft.selected);
    if (shared.length) root.append(el(document, 'p', 'dshcfg-warn', `多个来源声明了同一 provider：${shared.map(row => `${row.id}（${row.owners.join('、')}）`).join('；')}。内容相同会去重，不同会被拒绝保存。`));
    const follow = el(document, 'label', 'pref-row');
    const followText = el(document, 'div'); followText.append(el(document, 'strong', '', '自动跟随来源更新'), el(document, 'small', 'fine', draft.autoFollow ? '每个新 runtime 创建前重新读取所选文件；无效或冲突时阻止启动，不回退旧版本。' : '新 runtime 使用上次有效的冻结快照，只有手动更新才变化。'));
    const toggle = el(document, 'input', 'switch'); toggle.type = 'checkbox'; toggle.checked = draft.autoFollow; toggle.disabled = busy; toggle.setAttribute('aria-label', '自动跟随来源更新');
    toggle.addEventListener('change', () => { draft.autoFollow = toggle.checked; render(); });
    follow.append(followText, toggle);
    const actions = el(document, 'div', 'work-row');
    const save = el(document, 'button', 'btn primary', '保存选择'); save.type = 'button'; save.disabled = busy || !dirty();
    save.addEventListener('click', () => {
      const plan = configureBody(status, draft); if (plan.error) { say(plan.error, true); return; }
      const what = plan.body.sourceIds.length ? '' : '仅使用内置模型';
      call('/api/dsh/config-sources/configure', plan.body, status.activation?.state === 'active' ? `已保存${what ? '为' + what : ''}：之后新建的 runtime 生效，运行中的任务不受影响。` : `已保存${what ? '为' + what : '配置'}；重启 DSH 桥后才会对新 runtime 生效。`);
    });
    const revert = el(document, 'button', 'btn', '撤销修改'); revert.type = 'button'; revert.disabled = busy || !dirty(); revert.addEventListener('click', () => { resetDraft(); message = { text: '', error: false }; render(); });
    const refresh = el(document, 'button', 'btn', '立即更新快照'); refresh.type = 'button'; refresh.disabled = busy || dirty() || !(status.selectedSourceIds || []).length;
    refresh.title = dirty() ? '先保存或撤销当前修改' : !(status.selectedSourceIds || []).length ? '仅使用内置模型时没有需要重新读取的来源文件' : '重新读取所选文件并生成下一个新 runtime 使用的快照；不重启现有 runtime';
    refresh.addEventListener('click', () => call('/api/dsh/config-sources/refresh', {}, '快照已更新；只影响之后新建的 runtime。'));
    actions.append(save, revert, refresh);
    const panel = el(document, 'div', 'panel'); panel.append(follow, actions);
    root.append(panel);
    const register = el(document, 'form', 'dshcfg-register');
    const input = el(document, 'input'); input.placeholder = '自定义 cordis.patch.yml 的绝对路径'; input.setAttribute('aria-label', '自定义配置文件路径'); input.autocomplete = 'off'; input.spellcheck = false; input.disabled = busy;
    const add = el(document, 'button', 'btn', '注册来源'); add.type = 'submit'; add.disabled = busy;
    register.append(icon(document, 'file', { size: 16 }), input, add);
    register.addEventListener('submit', event => { event.preventDefault(); const path = input.value.trim(); if (!path) return; call('/api/dsh/config-sources/register', { path }, '已注册并校验；勾选后保存才会使用。'); });
    root.append(register, el(document, 'p', 'fine', '注册只记录并校验该文件，不会自动选中，也不会修改它。'));
    appendMessage();
  }
  function appendMessage() { if (!message.text) return; const p = el(document, 'p', message.error ? 'inline-error' : 'fine', message.text); p.setAttribute('role', 'status'); root.append(p); }
  render();
  return { activate() { message = { text: '', error: false }; load(); }, deactivate() { generation++; busy = false; }, snapshot: () => ({ status, draft }) };
}
