// Pending server requests (command/file approvals, permission grants, MCP forms, user input).
// Nothing is approved automatically: every response needs an explicit click, and stale requests are refused.
export function renderApprovals(host, deps) {
  const { document, requests, currentThreadId, api, notice, confirm, el, boundedText, permissionOptions, permissionResponse, formDefinition, formResponse, rerender } = deps;
  const state = { requests, thread: currentThreadId ? { id: currentThreadId } : null };
  const renderRequests = rerender;
  const frag = document.createDocumentFragment();
  for (const [key, request] of state.requests) {
    const p = request.params || {}; const card = el('section', 'approval'); card.append(el('h3', '', '需要你确认 · ' + request.method.split('/').slice(-2).join('/')));
    if (p.threadId && p.threadId !== state.thread?.id) card.append(el('p', '', '这是另一对话的请求：' + p.threadId));
    if (p.reason || p.message) card.append(el('p', '', boundedText(p.reason || p.message, 4000)));
    if (p.command) card.append(el('pre', '', boundedText(p.command, 8000))); if (p.cwd) card.append(el('p', '', '工作目录：' + p.cwd));
    const raw = el('details'); raw.append(el('summary', '', '查看完整请求详情'), el('pre', '', boundedText(JSON.stringify(p, null, 2), 16000))); card.append(raw);
    const actions = el('div', 'actions');
    let responseInFlight = false;
    const respond = async (result, error) => { if (responseInFlight) return; if (state.requests.get(key) !== request) { notice('该请求已结束或已更新，不能提交旧审批。', true); return; } responseInFlight = true; const controls = [...card.querySelectorAll('button,input,select,textarea')]; const disabled = controls.map(control => control.disabled); controls.forEach(control => {control.disabled = true;}); try { await api('/api/respond', { id: request.id, ...(error ? { error } : { result }) }); if (state.requests.get(key) === request) state.requests.delete(key); renderRequests(); } catch (e) { notice(e.message, true); if (state.requests.get(key) === request) controls.forEach((control,index) => {control.disabled = disabled[index];}); } finally {responseInFlight = false;} };
    const add = (label, result, accept = false) => { const b = el('button', accept ? 'accept' : '', label); b.addEventListener('click', () => respond(typeof result === 'function' ? result() : result)); actions.append(b); };
    if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
      const allowed = p.availableDecisions;
      if (!Array.isArray(allowed) || allowed.includes('decline')) add('拒绝', { decision: 'decline' });
      if (Array.isArray(allowed) && !allowed.includes('decline') && allowed.includes('cancel')) add('取消', { decision: 'cancel' });
      if (!Array.isArray(allowed) || allowed.includes('accept')) add('仅允许这一次', { decision: 'accept' }, true);
      if (!actions.children.length) card.append(el('p', '', '此请求没有本界面支持的单次决定，请在官方客户端处理。'));
    } else if (request.method === 'mcpServer/elicitation/request') {
      card.append(el('p', 'approval-recipient', '接收此表单的 MCP 服务：' + boundedText(p.serverName || '未知服务', 200)));
      card.append(el('p', 'approval-scope', '关联对话：' + boundedText(p.threadId || '未提供', 200) + '；任务：' + boundedText(p.turnId || '非任务级请求', 200)));
      const definition = formDefinition(p);
      if (!p.serverName || !p.threadId || !definition.supported) card.append(el('p', 'inline-error', definition.reason || '服务或对话标识缺失，不能发送表单。'));
      else {
        const form = el('form', 'approval-form'); const inputs = new Map();
        for (const field of definition.fields) {
          const label = el('label', 'approval-field'); label.append(el('span', '', field.title + (field.required ? '（必填）' : '（选填）')));
          const input = document.createElement(field.enum || field.type === 'boolean' ? 'select' : 'input');
          if (field.enum || field.type === 'boolean') { input.append(new Option('请选择', '')); const values = field.type === 'boolean' ? [['true','是'],['false','否']] : field.enum.map((value,index) => [value,field.enumNames?.[index] || value]); for (const [value,text] of values) input.append(new Option(text,value)); }
          else {input.type = ['number','integer'].includes(field.type) ? 'number' : 'text'; input.autocomplete = 'off'; input.spellcheck = false; if (input.type === 'number') { input.step = field.type === 'integer' ? '1' : 'any'; if (field.minimum !== undefined) input.min = String(field.minimum); if (field.maximum !== undefined) input.max = String(field.maximum); } else input.maxLength = field.maxLength ?? 10000; }
          input.required = field.required; label.append(input); if (field.description) label.append(el('small', '', field.description));
          const bounds = [field.format && '格式：' + field.format, field.minLength !== undefined && '最短 ' + field.minLength + ' 字符', field.maxLength !== undefined && '最长 ' + field.maxLength + ' 字符', field.minimum !== undefined && '最小值 ' + field.minimum, field.maximum !== undefined && '最大值 ' + field.maximum].filter(Boolean);if(bounds.length)label.append(el('small','',bounds.join('；')));
          form.append(label); inputs.set(field.name,{field,input});
        }
        form.append(el('p','approval-scope','只有你点击发送后才将这些字段交给上述 MCP 服务；不保存到本地存储或日志。'));
        const submit = el('button','accept','发送表单给此服务'); submit.type='submit'; form.append(submit);
        form.addEventListener('submit',event=>{event.preventDefault();try{const values=Object.fromEntries([...inputs].map(([name,{field,input}])=>[name,input.value===''?undefined:field.type==='boolean'?input.value==='true':['number','integer'].includes(field.type)?Number(input.value):input.value]));const response=formResponse(p,values);if(!confirm('将当前表单中填写的信息发送给 MCP 服务“'+p.serverName+'”？这不会自动批准其他请求。'))return;respond(response);}catch(error){notice(error.message,true);}});
        card.append(form);
      }
      add('拒绝请求', { action: 'decline', content: null, _meta: null }); add('取消本次表单', { action: 'cancel', content: null, _meta: null });
    } else if (request.method === 'item/permissions/requestApproval') {
      card.append(el('p','approval-recipient','权限接收方：此 Codex 对话中的当前任务。范围仅本轮，不保存为会话授权。'));
      card.append(el('p','approval-scope','对话：'+boundedText(p.threadId||'未提供',200)+'；任务：'+boundedText(p.turnId||'未提供',200)+'；环境：'+boundedText(p.environmentId||'本地 / 未提供',200)));
      const definition=permissionOptions(p);const checks=[];
      if(!p.threadId||!p.turnId||!definition.supported)card.append(el('p','inline-error',definition.reason||'缺少对话/任务标识，不能授予权限。'));
      else if (!definition.options.length)card.append(el('p','','请求中没有此界面可选择的额外权限。'));
      else {
        const fields=el('fieldset','approval-permissions');fields.append(el('legend','','选择本轮允许的权限（默认全部不选）'));
        for(const option of definition.options){const label=el('label','permission-choice');const input=document.createElement('input');input.type='checkbox';input.checked=false;label.append(input,el('span','',option.label));fields.append(label);checks.push({id:option.id,input});}card.append(fields);
        const grant=el('button','accept','仅本轮授予所选权限');grant.disabled=true;fields.addEventListener('change',()=>{grant.disabled=!checks.some(check=>check.input.checked);});
        grant.addEventListener('click',()=>{try{const chosen=checks.filter(check=>check.input.checked).map(check=>check.id);if(!chosen.length)return;const result=permissionResponse(p,chosen);if(!confirm('仅为当前任务本轮授予勾选的网络/文件权限？未勾选项不会授予，也不会保存为会话授权。'))return;respond(result);}catch(error){notice(error.message,true);}});actions.append(grant);
      }
      add('不授予权限', { permissions: {}, scope: 'turn' });
    } else if (request.method === 'item/tool/requestUserInput' || request.method === 'tool/requestUserInput') {
      const inputs = new Map(); for (const q of p.questions || []) { const label = el('label', '', q.question || q.header || q.id); const input = document.createElement(q.options?.length && !q.isOther ? 'select' : 'input'); if (q.options?.length && !q.isOther) { input.append(new Option('请选择', '')); for (const o of q.options) input.append(new Option(`${o.label}${o.description ? ' · ' + o.description : ''}`, o.label)); } else if (q.options?.length) { const hints = el('p', '', q.options.map(o => o.label).join(' / ')); label.append(hints); } label.append(input); card.append(label); inputs.set(q.id, input); }
      const submit = el('button', 'accept', '提交回答'); submit.addEventListener('click', () => { if ([...inputs.values()].some(i => !i.value.trim())) { notice('请回答全部问题。'); return; } respond({ answers: Object.fromEntries([...inputs].map(([id, input]) => [id, { answers: [input.value] }])) }); }); actions.append(submit);
    } else {
      card.append(el('p', '', '当前界面还不支持这个请求。不会自动批准。'));
      const decline = el('button', '', '拒绝不支持的请求'); decline.addEventListener('click', () => respond(null, { code: -32601, message: 'Unsupported request in Codex Light client' })); actions.append(decline);
    }
    card.append(actions); frag.append(card);
  }
  host.replaceChildren(frag);
}
