// Pending server requests: command/file approvals (modern + legacy), permission grants, MCP forms,
// request_user_input questions. Nothing is answered automatically: every response is an explicit click,
// carries the bridge instance token, and a request that ended or was replaced cannot be answered.
// Cards are cached per request instance so drafts survive other requests arriving or resolving.
import { permissionOptions, permissionResponse, formDefinition, formResponse, userInputDefinition, userInputResponse, requestKey, requestThread, approvalDecisions } from '../approval-schemas.js';

const caches = new WeakMap();
let sequence = 0;
const MODERN_COMMAND = 'item/commandExecution/requestApproval', MODERN_FILE = 'item/fileChange/requestApproval';
const LEGACY_DENIED = { decision: { denied: { rejection: 'rejected by user' } } };
// Decision material (commands, diffs, request text) is shown in full up to this many characters.
const RAW_LIMIT = 262144, TEXT_LIMIT = 200000;

export function renderApprovals(host, deps) {
  let cache = caches.get(host); if (!cache) { cache = new Map(); caches.set(host, cache); }
  const wanted = [];
  for (const [key, request] of deps.requests) {
    const instance = key + '\u0000' + (request.bridgeRequestToken ?? '');
    let entry = cache.get(instance);
    if (!entry) { entry = buildCard(key, request, deps); cache.set(instance, entry); }
    entry.update(deps); wanted.push(instance);
  }
  for (const [instance, entry] of cache) if (!wanted.includes(instance)) { entry.dispose(); cache.delete(instance); }
  // Reconcile in place: untouched cards keep focus, selections and typed drafts.
  const cards = wanted.map(instance => cache.get(instance).card);
  for (const child of [...host.children]) if (!cards.includes(child)) child.remove();
  cards.forEach((card, index) => { if (host.children[index] !== card) host.insertBefore(card, host.children[index] || null); });
}

const commandText = command => Array.isArray(command) ? command.map(part => /[\s"']/.test(String(part)) ? JSON.stringify(String(part)) : String(part)).join(' ') : String(command);
const compact = value => { try { return JSON.stringify(value); } catch { return String(value); } };

function buildCard(key, request, initialDeps) {
  let deps = initialDeps;
  const { document, el, boundedText } = initialDeps;
  const p = request.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params : {};
  const uid = 'approval-' + (++sequence);
  const card = el('section', 'approval'); card.dataset.requestKey = key;
  const title = el('h3', ''); title.id = uid + '-title'; card.setAttribute('aria-labelledby', title.id);
  const scope = el('p', 'approval-scope'); scope.hidden = true;
  const body = el('div', 'approval-body');
  const error = el('p', 'inline-error approval-error'); error.id = uid + '-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const status = el('p', 'approval-status'); status.setAttribute('role', 'status');
  const actions = el('div', 'actions');
  const raw = el('details', 'approval-raw'); const rawSummary = el('summary', '', '请求原文'); const rawBody = el('pre', ''); raw.append(rawSummary, rawBody);
  // Filled on first open; up to RAW_LIMIT characters, with the limit stated in the summary when reached.
  const rawText = (() => { try { return JSON.stringify(p, null, 2); } catch { return String(p); } })();
  if (rawText.length > RAW_LIMIT) rawSummary.textContent = `请求原文（共 ${rawText.length} 字符，此处只显示前 ${RAW_LIMIT} 字符）`;
  raw.addEventListener('toggle', () => { if (raw.open && !rawBody.textContent) rawBody.textContent = rawText.length > RAW_LIMIT ? rawText.slice(0, RAW_LIMIT) + '\n…〔其余部分未在此显示〕' : rawText; });
  card.append(title, scope, body, error, status, actions, raw);

  let busy = false;
  const live = () => { const now = deps.requests.get(key); return !!now && now.bridgeRequestToken === request.bridgeRequestToken; };
  const showError = (text, control) => { error.textContent = text; error.hidden = false; if (control) { control.setAttribute('aria-invalid', 'true'); control.setAttribute('aria-describedby', [control.dataset.hint, error.id].filter(Boolean).join(' ')); control.focus?.(); } };
  const clearError = () => { error.textContent = ''; error.hidden = true; for (const node of card.querySelectorAll('[aria-invalid]')) { node.removeAttribute('aria-invalid'); if (node.dataset.hint) node.setAttribute('aria-describedby', node.dataset.hint); else node.removeAttribute('aria-describedby'); } };
  const respond = async payload => {
    if (busy) return false;
    if (!live()) { showError('该请求已结束或已更新，不能再提交。'); return false; }
    busy = true; clearError();
    const controls = [...card.querySelectorAll('button,input,select,textarea')]; const was = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; }); card.setAttribute('aria-busy', 'true'); status.textContent = '正在发送…';
    try {
      await deps.api('/api/respond', { id: request.id, bridgeRequestToken: request.bridgeRequestToken, ...payload });
      if (live()) deps.requests.delete(key);
      deps.rerender(); return true;
    } catch (e) {
      if (e?.code === 'STALE_APPROVAL') { if (live()) deps.requests.delete(key); deps.notice('该请求已结束或已被新的请求替换，这次选择没有发送。', true); deps.rerender(); return false; }
      controls.forEach((control, index) => { control.disabled = was[index]; });
      showError((e?.message || '发送失败') + '。已填写的内容仍保留，可再次提交。'); return false;
    } finally { busy = false; card.removeAttribute('aria-busy'); status.textContent = ''; }
  };
  const button = (label, handler, className = '') => { const b = el('button', className, label); b.type = 'button'; b.addEventListener('click', handler); actions.append(b); return b; };
  const line = (text, className = '') => { const node = el('p', className, text); body.append(node); return node; };
  const ctx = { document, el, boundedText, uid, card, title, body, actions, respond, button, line, showError, clearError, lookupFileChange: initialDeps.lookupFileChange };

  const method = request.method;
  if (method === MODERN_COMMAND || method === MODERN_FILE) modernApproval(ctx, p, method);
  else if (method === 'execCommandApproval' || method === 'applyPatchApproval') legacyApproval(ctx, p, method);
  else if (method === 'item/permissions/requestApproval') permissionsApproval(ctx, p);
  else if (method === 'mcpServer/elicitation/request') mcpElicitation(ctx, p);
  else if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') userInput(ctx, p);
  else unsupported(ctx, method);

  return {
    card,
    update(next) {
      deps = next;
      const thread = requestThread(request);
      scope.hidden = !thread || thread === next.currentThreadId;
      scope.textContent = scope.hidden ? '' : '来自另一个对话：' + boundedText(String(thread), 200);
      // The correlated fileChange item may arrive after the request; refresh only that block.
      ctx.refreshFiles?.(next.lookupFileChange);
    },
    // Drop typed drafts (including masked answers) as soon as the request is gone.
    dispose() { for (const input of card.querySelectorAll('input,textarea')) input.value = ''; card.remove(); },
  };
}

function scopedAllow(ctx, choices) {
  const {document,el,body,actions,button,respond}=ctx;
  if(!choices.length)return;
  const hint=el('p','approval-scope');hint.id=ctx.uid+'-scope-hint';body.append(hint);
  const rule=el('pre','approval-rule');rule.hidden=true;body.append(rule);
  const select=document.createElement('select');select.className='approval-scope-select';select.setAttribute('aria-label','允许范围');select.setAttribute('aria-describedby',hint.id);
  for(const choice of choices){const option=document.createElement('option');option.value=choice.id;option.textContent=choice.label;select.append(option);}
  const selected=()=>choices.find(choice=>choice.id===select.value)||choices[0];
  const sync=()=>{const choice=selected();hint.textContent=choice.scope;rule.hidden=!choice.rule;rule.textContent=choice.rule?'命令前缀规则：\n'+JSON.stringify(choice.rule):'';};
  select.addEventListener('change',sync);sync();
  if(choices.length>1)actions.append(select);
  button(choices.length>1?'允许':choices[0].label,()=>respond({result:{decision:selected().decision}}),'accept');
}

function decisionButtons(ctx, choices, decisions) {
  const { button, respond } = ctx;
  scopedAllow(ctx,choices);
  if (decisions.includes('decline')) button('拒绝', () => respond({ result: { decision: 'decline' } }));
  if (decisions.includes('cancel')) button('停止本轮', () => respond({ result: { decision: 'cancel' } }));
}

function modernApproval(ctx, p, method) {
  const { title, line, boundedText, el, body } = ctx;
  const listed = Array.isArray(p.availableDecisions) ? p.availableDecisions.filter(decision => typeof decision === 'string') : null;
  let choices=approvalDecisions(method,p);
  const once = ['accept', 'decline', 'cancel'].filter(decision => !listed || listed.includes(decision));
  if (method === MODERN_FILE) {
    title.textContent = '允许修改文件？';
    if (p.reason) line(boundedText(p.reason, 4000));
    // Params usually carry only itemId; the files and diff come from the correlated fileChange item.
    const holder = el('div', 'approval-changes'); body.append(holder);
    let signature = null;
    ctx.refreshFiles = lookup => {
      const material = lookup && typeof p.itemId === 'string' && p.itemId ? lookup(requestThread({ params: p }), p.itemId) : null;
      // Signature covers the actual diff text, so a same-length replacement (patchUpdated) still re-renders.
      const next = material?.changes?.length ? JSON.stringify([material.partial, material.truncated, material.changes.map(change => [change?.path, change?.kind?.type ?? change?.kind, change?.kind?.move_path, typeof change?.diff === 'string' ? change.diff : null])]) : 'none:' + (material?.reason || '');
      if (next === signature) return;
      signature = next; ctx.fileMaterial = () => !!material?.changes?.length;
      holder.replaceChildren();
      if (material?.changes?.length) renderChanges(ctx, holder, material.changes.map(change => ({ path: change?.path, kind: change?.kind?.type ?? change?.kind, movePath: change?.kind?.move_path, diff: change?.diff })), material.partial, material.truncated, { modern: true });
      // Modern params carry only identifiers, so the request text cannot stand in for the missing files.
      else holder.append(el('p', 'inline-error', (typeof p.itemId === 'string' && p.itemId
        ? '没有载入这次要修改的文件和内容' + (material?.reason ? '（' + material.reason + '）' : '')
        : '请求没有提供关联的修改内容') + '。请求原文只包含请求标识，看不到具体修改；无法核对时请拒绝。'));
    };
    ctx.refreshFiles(ctx.lookupFileChange);
    if (p.grantRoot) line('请求写入目录：' + boundedText(String(p.grantRoot), 1000) + '。目录级授权是否生效由 Codex 决定；本对话允许针对相同文件。', 'approval-scope');
  } else {
    const kind = p.kind ?? 'command';
    if (kind === 'humanCommand') {
      title.textContent = '需要你本人确认';
      line('这是 Codex 要求的人工检查点，此提示本身不会启动命令。你的决定只对这一次有效，不会被记住。', 'approval-recipient');
    } else if (kind === 'writeStdin') { title.textContent = '向正在运行的终端发送输入？'; }
    else if (kind === 'command') { title.textContent = p.networkApprovalContext ? '允许网络访问？' : '允许运行命令？'; }
    else {
      title.textContent = '无法识别的审批类型';
      line('审批类型“' + boundedText(String(kind), 100) + '”无法在此确认，只能拒绝。', 'inline-error');
      once.splice(0, once.length, ...once.filter(decision => decision !== 'accept'));
      choices=[];
    }
    if (p.reason) line(boundedText(p.reason, 4000));
    if (p.networkApprovalContext?.host) line('网络目标：' + boundedText(String(p.networkApprovalContext.host), 500) + (p.networkApprovalContext.protocol ? '（' + boundedText(String(p.networkApprovalContext.protocol), 40) + '）' : ''));
    if (p.command) body.append(el('pre', '', boundedText(commandText(p.command), TEXT_LIMIT)));
    if (p.cwd) line('工作目录：' + boundedText(String(p.cwd), 1000));
    if (p.additionalPermissions) line('同时请求额外权限：' + boundedText(compact(p.additionalPermissions), 2000), 'approval-scope');
  }
  if (choices.length||once.length) decisionButtons(ctx, choices, once);
  else {
    line('请求只提供此界面不支持的选项。可以拒绝，Codex 会按未批准处理。', 'inline-error');
    ctx.button('拒绝', () => ctx.respond({ error: { code: -32601 } }));
  }
}

function legacyApproval(ctx, p, method) {
  const { title, line, boundedText, el, body, button, respond } = ctx;
  if (method === 'execCommandApproval') {
    title.textContent = '允许运行命令？';
    if (p.reason) line(boundedText(p.reason, 4000));
    if (p.command) body.append(el('pre', '', boundedText(commandText(p.command), TEXT_LIMIT)));
    if (p.cwd) line('工作目录：' + boundedText(String(p.cwd), 1000));
  } else {
    title.textContent = '允许修改文件？';
    if (p.reason) line(boundedText(p.reason, 4000));
    const files = p.fileChanges && typeof p.fileChanges === 'object' && !Array.isArray(p.fileChanges) ? Object.entries(p.fileChanges) : [];
    if (files.length) renderChanges(ctx, body, files.map(([path, change]) => ({ path, kind: change?.type, movePath: change?.move_path, diff: change?.unified_diff ?? change?.content })));
    else line('请求没有列出要修改的文件，无法核对具体修改；无法确认时请拒绝。', 'inline-error');
    if (p.grantRoot) line('请求在本会话中允许写入：' + boundedText(String(p.grantRoot), 1000) + '。目录授权是否生效由 Codex 决定。', 'approval-scope');
  }
  scopedAllow(ctx,approvalDecisions(method,p));
  button('拒绝', () => respond({ result: LEGACY_DENIED }));
  button('停止本轮', () => respond({ result: { decision: 'abort' } }));
}

// Lists every file with its change kind; each diff opens on demand and is shown in full up to TEXT_LIMIT.
// Legacy params embed the changes, so the request text holds the rest; modern changes come from the
// conversation item and are not in the request text.
function renderChanges(ctx, host, changes, partial = false, truncated = false, { modern = false } = {}) {
  const { el, boundedText } = ctx;
  const kinds = { add: '新增', delete: '删除', update: '修改' };
  const list = el('ul', 'approval-files');
  for (const change of changes.slice(0, 200)) {
    const item = el('li', '');
    const label = boundedText(String(change.path || '（未命名）'), 2000) + (change.movePath ? ' → ' + boundedText(String(change.movePath), 2000) : '') + (kinds[change.kind] ? ' · ' + kinds[change.kind] : '');
    if (typeof change.diff === 'string' && change.diff) {
      const details = el('details', 'approval-diff'); const summary = el('summary', '', label); const pre = el('pre', ''); details.append(summary, pre);
      details.addEventListener('toggle', () => { if (details.open && !pre.textContent) pre.textContent = boundedText(change.diff, TEXT_LIMIT); });
      item.append(details);
    } else item.append(el('span', '', label + ' · 未提供内容'));
    list.append(item);
  }
  host.append(list);
  if (changes.length > 200) host.append(el('p', 'approval-scope', `另有 ${changes.length - 200} 个文件未在此列出` + (modern ? '，无法在此核对；无法确认时请拒绝。' : '，见请求原文。')));
  if (partial) host.append(el('p', 'approval-scope', '修改内容可能还在生成中，以上为目前收到的部分。'));
  if (truncated) host.append(el('p', 'approval-scope', modern
    ? '以上来自对话记录，超出界面保留上限的部分没有保留，可能不完整；请求原文不包含这些修改。无法确认时请拒绝。'
    : '部分内容超出显示上限，可能不完整；其余部分见请求原文。'));
}

function permissionsApproval(ctx, p) {
  const { title, line, boundedText, el, body, button, respond, uid, document, showError } = ctx;
  title.textContent = '授予额外权限？';
  if (p.reason) line(boundedText(p.reason, 4000));
  line('仅授予勾选的权限；可以选择本轮或当前对话范围。', 'approval-scope');
  const definition = permissionOptions(p);
  if (!p.threadId || !p.turnId || !definition.supported) line(definition.reason || '缺少对话或任务标识，不能授予权限。', 'inline-error');
  else if (!definition.options.length) line('请求中没有可以选择的额外权限。');
  else {
    const fields = el('fieldset', 'approval-permissions'); fields.append(el('legend', '', '选择允许的权限'));
    const checks = [];
    for (const option of definition.options) { const label = el('label', 'permission-choice'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = false; label.append(input, el('span', '', boundedText(option.label, 1200))); fields.append(label); checks.push({ id: option.id, input }); }
    for (const restriction of definition.restrictions) fields.append(el('p', 'permission-restriction', '始终保留：' + boundedText(restriction.label, 1200)));
    body.append(fields);
    const hint = el('p', 'approval-scope', '至少勾选一项才能授予。'); hint.id = uid + '-grant-hint'; body.append(hint);
    const scope=document.createElement('select');scope.className='approval-scope-select';scope.setAttribute('aria-label','权限有效范围');for(const [value,label]of [['turn','仅本轮'],['session','本对话']]){const option=document.createElement('option');option.value=value;option.textContent=label;scope.append(option);}ctx.actions.append(scope);
    const scopeHint=el('p','approval-scope','本轮结束后授权失效。');scopeHint.id=uid+'-scope-description';body.append(scopeHint);scope.setAttribute('aria-describedby',scopeHint.id);scope.addEventListener('change',()=>{scopeHint.textContent=scope.value==='session'?'所选权限持续至当前 Codex 会话结束，不保存为永久权限。':'本轮结束后授权失效。';});
    const grant = button('允许所选', async () => {
      const chosen = checks.filter(check => check.input.checked).map(check => check.id); if (!chosen.length) return;
      let result; try { result = permissionResponse(p, chosen,scope.value); } catch (error) { showError(error.message); return; }
      await respond({ result });
    }, 'accept');
    grant.disabled = true; grant.dataset.hint = hint.id; grant.setAttribute('aria-describedby', hint.id);
    const sync = () => { const any = checks.some(check => check.input.checked); grant.disabled = !any; hint.hidden = any; };
    fields.addEventListener('change', sync);
  }
  button('不授予', () => respond({ result: { permissions: {}, scope: 'turn' } }));
}

function mcpElicitation(ctx, p) {
  const { title, line, boundedText, el, body, button, respond, uid, document, showError, clearError } = ctx;
  const server = boundedText(String(p.serverName || '未知服务'), 200);
  const meta = p._meta && typeof p._meta === 'object' && !Array.isArray(p._meta) ? p._meta : null;
  const toolApproval = meta?.codex_approval_kind === 'mcp_tool_call';
  title.textContent = toolApproval ? `允许 MCP 服务「${server}」运行工具？` : `MCP 服务「${server}」请求信息`;
  if (p.message) line(boundedText(String(p.message), 4000));
  const definition = formDefinition(p);
  const decline = () => { button('拒绝', () => respond({ result: { action: 'decline', content: null, _meta: null } })); button('取消', () => respond({ result: { action: 'cancel', content: null, _meta: null } })); };
  if (!p.serverName || !p.threadId || !definition.supported) {
    line(definition.supported ? '缺少服务或对话标识，不能发送。' : definition.reason, 'inline-error');
    if (p.mode === 'url' && typeof p.url === 'string') line('服务提供的地址（未打开）：' + boundedText(p.url, 2000), 'approval-scope');
    decline(); return;
  }
  if (definition.messageOnly) {
    if (toolApproval) {
      const shown = Array.isArray(meta.tool_params_display) ? meta.tool_params_display.filter(row => row && typeof row.name === 'string').map(row => [row.display_name || row.name, row.value]) : meta.tool_params && typeof meta.tool_params === 'object' ? Object.entries(meta.tool_params) : [];
      if (typeof meta.tool_name === 'string') line('工具：' + boundedText(meta.tool_name, 200));
      if (shown.length) { const list = el('ul', 'approval-files'); for (const [name, value] of shown.slice(0, 20)) list.append(el('li', '', boundedText(String(name), 200) + '：' + boundedText(typeof value === 'string' ? value : compact(value), 600))); body.append(list); }
    }
    line('只允许这一次，不记住此选择。', 'approval-scope');
    button(toolApproval ? '运行一次' : '允许一次', () => respond({ result: formResponse(p, null) }), 'accept');
    decline(); return;
  }
  const form = el('form', 'approval-form'); form.noValidate = true; const inputs = new Map();
  for (const field of definition.fields) {
    const id = `${uid}-${inputs.size}`;
    const wrap = el(field.multiple ? 'fieldset' : 'div', 'approval-field');
    const caption = field.title + (field.required ? '（必填）' : '（选填）');
    const hints = [field.description, field.format && '格式：' + field.format, field.minLength !== undefined && '最短 ' + field.minLength + ' 字符', field.maxLength !== undefined && '最长 ' + field.maxLength + ' 字符', field.minimum !== undefined && '最小值 ' + field.minimum, field.maximum !== undefined && '最大值 ' + field.maximum, field.minItems > 0 && '至少选 ' + field.minItems + ' 项', field.maxItems !== undefined && '最多选 ' + field.maxItems + ' 项'].filter(Boolean);
    const hint = hints.length ? el('small', '', boundedText(hints.join('；'), 4000)) : null; if (hint) hint.id = id + '-hint';
    let control, read;
    if (field.multiple) {
      wrap.append(el('legend', '', caption)); const boxes = [];
      for (const option of field.options) { const label = el('label', 'permission-choice'); const box = document.createElement('input'); box.type = 'checkbox'; box.value = option.value; label.append(box, el('span', '', boundedText(option.label, 1000))); wrap.append(label); boxes.push(box); }
      // Required: nothing checked is an explicit [] (minItems decides). Optional: nothing checked omits the property.
      control = boxes[0]; read = () => { const values = boxes.filter(box => box.checked).map(box => box.value); return values.length || field.required ? values : undefined; };
    } else {
      const label = el('label', '', caption); label.setAttribute('for', id); wrap.append(label);
      if (field.options || field.type === 'boolean') {
        control = document.createElement('select');
        const choices = field.type === 'boolean' ? [['true', '是'], ['false', '否']] : field.options.map(option => [option.value, option.label]);
        for (const [value, text] of [['', '请选择'], ...choices]) { const option = document.createElement('option'); option.value = value; option.textContent = boundedText(text, 1000); control.append(option); }
        read = () => control.value === '' ? undefined : field.type === 'boolean' ? control.value === 'true' : control.value;
      } else {
        control = document.createElement('input'); control.autocomplete = 'off'; control.spellcheck = false;
        if (field.type === 'number' || field.type === 'integer') { control.type = 'number'; control.step = field.type === 'integer' ? '1' : 'any'; if (field.minimum !== undefined) control.min = String(field.minimum); if (field.maximum !== undefined) control.max = String(field.maximum); }
        else { control.type = field.format === 'email' ? 'email' : 'text'; control.maxLength = field.maxLength ?? 10000; }
        read = () => {
          if (control.type === 'number') { if (control.validity?.badInput) throw Object.assign(new Error(field.title + '：请输入数字。'), { field: field.name }); return control.value === '' ? undefined : Number(control.value); }
          return control.value === '' ? undefined : control.value;
        };
      }
      control.id = id; control.required = field.required; wrap.append(control);
    }
    if (hint) { wrap.append(hint); if (control) { control.dataset.hint = hint.id; control.setAttribute('aria-describedby', hint.id); } }
    form.append(wrap); inputs.set(field.name, { control, read });
  }
  form.append(el('p', 'approval-scope', '点击发送后才会交给此服务；不会保存到本地。'));
  const submit = async () => {
    clearError(); let result;
    try { const values = {}; for (const [name, { read }] of inputs) { const value = read(); if (value !== undefined) values[name] = value; } result = formResponse(p, values); }
    catch (error) { showError(error.message, inputs.get(error.field)?.control); return; }
    await respond({ result });
  };
  form.addEventListener('submit', event => { event.preventDefault(); submit(); });
  body.append(form);
  button('发送表单给此服务', submit, 'accept');
  decline();
}

function userInput(ctx, p) {
  const { title, line, boundedText, el, body, button, respond, uid, document, showError } = ctx;
  title.textContent = 'Codex 需要你回答';
  const definition = userInputDefinition(p);
  if (!definition.supported) { line(definition.reason + ' 可以拒绝，Codex 会按未回答处理。', 'inline-error'); button('拒绝', () => respond({ error: { code: -32601 } })); return; }
  const readers = [];
  definition.questions.forEach((q, index) => {
    const qid = `${uid}-q${index}`;
    const group = el('fieldset', 'approval-question');
    const legend = el('legend', '', boundedText(q.header || q.question, 400)); legend.id = qid + '-legend'; group.append(legend);
    if (q.header && q.question && q.question !== q.header) { const prompt = el('p', 'approval-question-text', boundedText(q.question, 4000)); prompt.id = qid + '-text'; group.append(prompt); }
    const textField = (labelText) => {
      const input = document.createElement(q.secret ? 'input' : 'textarea');
      if (q.secret) { input.type = 'password'; input.autocomplete = 'off'; } else input.rows = 2;
      input.spellcheck = false; input.maxLength = 20000; input.id = qid + '-text-input';
      input.setAttribute('aria-label', labelText); return input;
    };
    if (q.options.length) {
      const radios = [];
      for (const option of q.options) {
        const label = el('label', 'approval-choice'); const radio = document.createElement('input'); radio.type = 'radio'; radio.name = qid; radio.value = option.label;
        const text = el('span', '', boundedText(option.label, 1000)); label.append(radio, text);
        if (option.description) label.append(el('small', '', boundedText(option.description, 2000)));
        group.append(label); radios.push(radio);
      }
      let otherRadio = null, otherInput = null;
      if (q.other) {
        const label = el('label', 'approval-choice'); otherRadio = document.createElement('input'); otherRadio.type = 'radio'; otherRadio.name = qid; otherRadio.value = '';
        label.append(otherRadio, el('span', '', '其他')); group.append(label);
        otherInput = textField((q.header || q.question) + '：其他回答'); otherInput.classList.add('approval-other');
        // Typing a custom answer selects "其他"; the card-level input listener refreshes the summary.
        otherInput.addEventListener('input', () => { if (otherInput.value) otherRadio.checked = true; });
        group.append(otherInput);
      }
      const clear = el('button', 'approval-clear', '清除选择'); clear.type = 'button'; clear.hidden = true;
      clear.addEventListener('click', () => { for (const radio of [...radios, otherRadio].filter(Boolean)) radio.checked = false; if (otherInput) otherInput.value = ''; refresh(); });
      group.append(clear);
      readers.push({ id: q.id, read: () => { if (otherRadio?.checked) return otherInput.value; return radios.find(radio => radio.checked)?.value; }, touched: () => radios.some(radio => radio.checked) || !!otherRadio?.checked, clear });
    } else {
      const input = textField(q.header || q.question);
      input.removeAttribute('aria-label'); input.setAttribute('aria-labelledby', [legend.id, q.header && q.question !== q.header ? qid + '-text' : null].filter(Boolean).join(' '));
      group.append(input);
      readers.push({ id: q.id, read: () => input.value });
    }
    if (q.secret) group.append(el('small', 'approval-scope', '敏感回答：输入内容被遮盖，只发送给 Codex，不保存。'));
    body.append(group);
  });
  const summary = el('p', 'approval-scope'); summary.setAttribute('aria-live', 'polite'); body.append(summary);
  const answered = reader => { const value = reader.read(); return typeof value === 'string' && value !== '' && (!!value.trim() || definition.questions.find(q => q.id === reader.id).secret); };
  const refresh = () => {
    for (const reader of readers) if (reader.clear) reader.clear.hidden = !reader.touched();
    const missing = readers.filter(reader => !answered(reader)).length;
    summary.textContent = missing ? `${missing} 题未回答，提交时作为跳过发送。` : '';
  };
  body.addEventListener('input', refresh); body.addEventListener('change', refresh); refresh();
  button('提交回答', async () => {
    let result; try { result = userInputResponse(p, Object.fromEntries(readers.map(reader => [reader.id, reader.read() ?? null]))); } catch (error) { showError(error.message); return; }
    await respond({ result });
  }, 'accept');
}

function unsupported(ctx, method) {
  const { title, line, boundedText, button, respond } = ctx;
  title.textContent = '无法处理的请求';
  line('此界面不支持“' + boundedText(String(method), 200) + '”。不会自动批准；可以拒绝让 Codex 继续。', 'inline-error');
  button('拒绝此请求', () => respond({ error: { code: -32601 } }));
}
