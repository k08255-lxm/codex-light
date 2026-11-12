// Behaviour tests for public/ui/approvals-view.js on miniDOM with synthetic requests only.
import test from 'node:test'; import assert from 'node:assert/strict';
import { createDocument, visibleText } from './mini-dom.mjs';
import { renderApprovals } from '../public/ui/approvals-view.js';
import { requestKey, permissionOptions, permissionResponse, formDefinition, formResponse, userInputResponse } from '../public/approval-schemas.js';

const threadId = 'thread-a', turnId = 'turn-a';
function setup({ api } = {}) {
  const document = createDocument(); const host = document.createElement('section');
  const requests = new Map(), posted = [], notices = [];
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  const deps = { document, requests, currentThreadId: threadId, el, boundedText: value => String(value), notice: (text, error) => notices.push({ text, error }),
    api: api || (async (path, body) => { posted.push(body); return { ok: true }; }), rerender: () => renderApprovals(host, deps) };
  const add = (request, token = 'token-' + JSON.stringify(request.id)) => { const value = { ...request, bridgeRequestToken: token }; requests.set(requestKey(request.id), value); deps.rerender(); return value; };
  return { document, host, requests, posted, notices, deps, add };
}
const all = node => node.descendants;
const buttons = node => all(node).filter(child => child.tag === 'button');
const byText = (node, text) => buttons(node).find(child => child.textContent === text);
const card = (x, id) => x.host.children.find(child => child.dataset.requestKey === requestKey(id));
const inputs = (node, type) => all(node).filter(child => child.tag === 'input' && (!type || child.type === type));
const click = async buttonNode => { assert.ok(buttonNode, 'button exists'); assert.ok(!buttonNode.disabled, 'button enabled'); for (const listener of buttonNode.listeners.click || []) await listener({ preventDefault() {} }); };
const ask = (id, questions) => ({ id, method: 'item/tool/requestUserInput', params: { threadId, turnId, itemId: 'i-' + id, isBlocking: true, questions } });

test('request_user_input: option, Other text, exact masked secret and skip return in one response', async () => {
  const x = setup();
  x.add(ask(7, [
    { id: 'pick', header: 'Mode', question: 'Pick a mode', isOther: true, options: [{ label: 'Fast (Recommended)', description: 'Quick' }, { label: 'Full', description: 'Slow' }] },
    { id: 'pin', header: 'PIN', question: 'Enter the code', isSecret: true, options: null },
    { id: 'note', header: 'Note', question: 'Anything else?', options: null },
    { id: 'choice', header: 'Choice', question: 'Second option set', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }
  ]));
  const node = card(x, 7);
  assert.equal(inputs(node, 'password').length, 1, 'secret answer is masked');
  assert.equal(all(node).filter(child => child.tag === 'textarea' && child.classList.contains('approval-other')).length, 1, 'Other exposes custom text');
  const other = all(node).find(child => child.classList.contains('approval-other'));
  other.value = 'my own words'; other.dispatch('input');
  inputs(node, 'password')[0].value = '  s3cr3t \t';
  await click(byText(node, '提交回答'));
  assert.deepEqual(x.posted, [{ id: 7, bridgeRequestToken: 'token-7', result: { answers: { pick: { answers: ['my own words'] }, pin: { answers: ['  s3cr3t \t'] }, note: { answers: [] }, choice: { answers: [] } } } }]);
  assert.equal(x.requests.size, 0); assert.equal(x.host.children.length, 0);
});

test('choice without Other cannot send free text; clearing a choice returns to skip', async () => {
  const x = setup();
  x.add(ask('q', [{ id: 'c', header: 'C', question: 'Pick', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]));
  const node = card(x, 'q');
  assert.equal(all(node).filter(child => child.tag === 'textarea').length, 0);
  const radios = inputs(node, 'radio'); assert.equal(radios.length, 2);
  radios[1].checked = true; node.descendants.find(child => child.classList.contains('approval-body')).dispatch('change');
  const clear = buttons(node).find(child => child.classList.contains('approval-clear')); assert.equal(clear.hidden, false);
  await click(clear); assert.equal(radios[1].checked, false);
  radios[0].checked = true; await click(byText(node, '提交回答'));
  assert.deepEqual(x.posted[0].result, { answers: { c: { answers: ['A'] } } });
  assert.throws(() => userInputResponse(ask(1, [{ id: 'c', options: [{ label: 'A', description: '' }] }]).params, { c: 'free text' }));
});

test('drafts survive other requests arriving/resolving and status refresh of the same instance', () => {
  const x = setup();
  x.add(ask(1, [{ id: 'a', header: 'A', question: 'Free', options: null }]));
  const first = card(x, 1), area = all(first).find(child => child.tag === 'textarea'); area.value = 'draft text';
  x.add({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'f' } });
  assert.equal(card(x, 1), first); assert.equal(area.value, 'draft text');
  x.requests.delete(requestKey(2)); x.deps.rerender();
  assert.equal(card(x, 1), first); assert.equal(area.value, 'draft text');
  x.requests.set(requestKey(1), { ...x.requests.get(requestKey(1)) }); x.deps.rerender();
  assert.equal(card(x, 1), first, 'same bridge instance keeps its card');
  x.add(ask(1, [{ id: 'a', header: 'A', question: 'Free', options: null }]), 'token-new');
  assert.notEqual(card(x, 1), first, 'reused native id with a new token is a new prompt');
  assert.equal(area.value, '', 'draft of the ended request is cleared');
});

test('numeric and string ids stay distinct and each response carries its own token', async () => {
  const x = setup();
  x.add({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'n' } }, 'tok-number');
  x.add({ id: '1', method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 's' } }, 'tok-string');
  assert.equal(x.host.children.length, 2);
  await click(byText(card(x, '1'), '拒绝'));
  assert.deepEqual(x.posted, [{ id: '1', bridgeRequestToken: 'tok-string', result: { decision: 'decline' } }]);
  assert.ok(card(x, 1)); assert.equal(x.host.children.length, 1);
});

test('double click sends once; failure keeps input for retry; stale 409 drops card without retry', async () => {
  let release, calls = 0;
  const x = setup({ api: async () => { calls++; if (calls === 1) await new Promise(resolve => { release = resolve; }); if (calls === 2) throw Object.assign(new Error('写入失败'), { code: 'INPUT_BACKPRESSURE' }); return { ok: true }; } });
  x.add({ id: 5, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'c', command: 'echo hi', availableDecisions: ['accept', 'decline'] } });
  const accept = byText(card(x, 5), '仅允许这一次');
  const first = click(accept); for (const listener of accept.listeners.click) listener({});
  assert.equal(accept.disabled, true); release(); await first; assert.equal(calls, 1);
  x.add(ask(6, [{ id: 'a', header: 'A', question: 'Free', options: null }]));
  const node = card(x, 6), area = all(node).find(child => child.tag === 'textarea'); area.value = 'keep me';
  await click(byText(node, '提交回答'));
  assert.equal(calls, 2); assert.equal(area.value, 'keep me'); assert.ok(!byText(node, '提交回答').disabled);
  assert.match(visibleText(node), /写入失败/);
  const y = setup({ api: async () => { throw Object.assign(new Error('stale'), { code: 'STALE_APPROVAL' }); } });
  y.add({ id: 8, method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'f' } });
  await click(byText(card(y, 8), '拒绝')); assert.equal(y.requests.size, 0); assert.equal(y.host.children.length, 0); assert.equal(y.notices.length, 1);
});

test('response after the request ended or was replaced is refused locally', async () => {
  const x = setup();
  x.add({ id: 9, method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'f' } });
  const node = card(x, 9), decline = byText(node, '拒绝');
  x.requests.set(requestKey(9), { ...x.requests.get(requestKey(9)), bridgeRequestToken: 'other' });
  for (const listener of decline.listeners.click) await listener({});
  assert.deepEqual(x.posted, []);
});

test('humanCommand is a fresh one-time human decision; no persistent options', async () => {
  const x = setup();
  x.add({ id: 'h', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'h', kind: 'humanCommand', command: 'deploy', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } });
  const node = card(x, 'h');
  assert.match(visibleText(node), /人工检查点/); assert.match(visibleText(node), /不会启动命令/);
  assert.deepEqual(buttons(node).map(b => b.textContent).filter(t => t !== '查看完整请求详情'), ['我确认，仅本次', '拒绝', '拒绝并停止本轮']);
  await click(byText(node, '我确认，仅本次')); assert.deepEqual(x.posted[0].result, { decision: 'accept' });
  x.add({ id: 'u', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'u', kind: 'futureKind' } });
  assert.equal(byText(card(x, 'u'), '仅允许这一次'), undefined, 'unknown kind cannot be approved');
});

test('legacy exec/applyPatch send native approved / denied / abort', async () => {
  const x = setup();
  for (const [id, method, label, result] of [['l1', 'execCommandApproval', '仅允许这一次', { decision: 'approved' }], ['l2', 'applyPatchApproval', '拒绝', { decision: { denied: { rejection: 'rejected by user' } } }], ['l3', 'execCommandApproval', '拒绝并停止本轮', { decision: 'abort' }]]) {
    x.add({ id, method, params: { conversationId: threadId, callId: id, command: ['echo', 'a b'], cwd: 'C:\\w', fileChanges: { 'C:\\w\\a.md': { type: 'update' } } } });
    await click(byText(card(x, id), label)); assert.deepEqual(x.posted.at(-1).result, result);
  }
});

test('permissions: unchecked default, modern entries subset keeps deny, legacy shape unchanged', async () => {
  const params = { threadId, turnId, itemId: 'p', permissions: { network: { enabled: true }, fileSystem: { entries: [
    { access: 'read', path: { type: 'path', path: 'C:\\proj' } }, { access: 'write', path: { type: 'path', path: 'C:\\proj\\out' } }, { access: 'deny', path: { type: 'path', path: 'C:\\proj\\private' } }] } } };
  const x = setup(); x.add({ id: 'p', method: 'item/permissions/requestApproval', params });
  const node = card(x, 'p'), boxes = inputs(node, 'checkbox'), grant = byText(node, '仅本轮授予所选权限');
  assert.equal(boxes.length, 3); assert.ok(boxes.every(box => !box.checked)); assert.equal(grant.disabled, true);
  assert.match(visibleText(node), /始终保留：禁止访问 C:\\proj\\private/);
  boxes[1].checked = true; all(node).find(child => child.tag === 'fieldset').dispatch('change');
  await click(grant);
  assert.deepEqual(x.posted[0].result, { permissions: { fileSystem: { entries: [{ access: 'read', path: { type: 'path', path: 'C:\\proj' } }, { access: 'deny', path: { type: 'path', path: 'C:\\proj\\private' } }] } }, scope: 'turn' });
  assert.deepEqual(permissionResponse(params, ['network']), { permissions: { network: { enabled: true } }, scope: 'turn' }, 'network-only grant needs no filesystem restriction');
  const legacy = { permissions: { fileSystem: { read: ['/a'], write: ['/b'] } } };
  assert.deepEqual(permissionResponse(legacy, [permissionOptions(legacy).options[0].id]), { permissions: { fileSystem: { read: ['/a'] } }, scope: 'turn' });
  for (const entries of [[{ access: 'read', path: { type: 'glob_pattern', pattern: '/a/*' } }], [{ access: 'read', path: { type: 'special', value: { kind: 'root' } } }], [{ access: 'read', path: { type: 'path', path: 'relative' } }], [{ access: 'read', path: { type: 'path', path: '/a/../b' } }], [{ access: 'read', path: { type: 'path', path: '/a' } }, { access: 'deny', path: { type: 'path', path: '/a' } }], [{ access: 'execute', path: { type: 'path', path: '/a' } }]])
    assert.equal(permissionOptions({ permissions: { fileSystem: { entries } } }).supported, false, JSON.stringify(entries));
  assert.equal(permissionOptions({ permissions: { fileSystem: { entries: [{ access: 'deny', path: { type: 'path', path: '/a' } }], read: ['/b'] } } }).supported, false, 'mixed forms must agree');
  const y = setup(); y.add({ id: 'q', method: 'item/permissions/requestApproval', params: { threadId, turnId, permissions: { fileSystem: { entries: [{ access: 'read', path: { type: 'glob_pattern', pattern: '**' } }] } } } });
  await click(byText(card(y, 'q'), '不授予')); assert.deepEqual(y.posted[0].result, { permissions: {}, scope: 'turn' });
});

test('MCP form: typed primitives incl. titled/multi select; secrets, URL and unknown kinds only decline/cancel', async () => {
  const params = { threadId, turnId, serverName: 'svc', mode: 'form', message: 'Fill', _meta: null, requestedSchema: { type: 'object', required: ['name'], properties: {
    name: { type: 'string', title: 'Name', minLength: 2, default: null }, count: { type: 'integer', minimum: 1, maximum: 5 }, ok: { type: 'boolean' },
    tier: { type: 'string', oneOf: [{ const: 'p', title: 'Pro' }, { const: 'f', title: 'Free' }] }, tags: { type: 'array', items: { type: 'string', enum: ['x', 'y'] }, maxItems: 2 } } } };
  assert.equal(formDefinition(params).supported, true);
  const x = setup(); x.add({ id: 'm', method: 'mcpServer/elicitation/request', params });
  const node = card(x, 'm');
  await click(byText(node, '发送表单给此服务'));
  assert.deepEqual(x.posted, [], 'required field blocks send'); const name = inputs(node).find(child => child.type === 'text');
  assert.equal(name.getAttribute('aria-invalid'), 'true'); assert.match(visibleText(node), /Name：请填写此必填项/);
  name.value = 'Li'; const selects = all(node).filter(child => child.tag === 'select'); selects[0].value = 'false'; selects[1].value = 'p';
  inputs(node, 'checkbox')[1].checked = true; inputs(node, 'number')[0].value = '3';
  await click(byText(node, '发送表单给此服务'));
  assert.deepEqual(x.posted[0].result, { action: 'accept', content: { name: 'Li', count: 3, ok: false, tier: 'p', tags: ['y'] }, _meta: null });
  assert.equal(name.getAttribute('aria-invalid'), null);
  for (const [id, p] of [['s', { ...params, requestedSchema: { type: 'object', properties: { api_key: { type: 'string' } } } }], ['url', { threadId, serverName: 'svc', mode: 'url', url: 'https://example.invalid', elicitationId: 'e', message: 'Login' }], ['uv', { threadId, serverName: 'svc', mode: 'openai/userVerification', title: 't', description: 'd', challenge: 'c' }], ['sg', { ...params, requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'tool_suggestion' } }]]) {
    x.add({ id, method: 'mcpServer/elicitation/request', params: p });
    const labels = buttons(card(x, id)).map(b => b.textContent); assert.deepEqual(labels.filter(t => t !== '发送表单给此服务'), ['拒绝', '取消'], id);
    assert.equal(byText(card(x, id), '发送表单给此服务'), undefined);
  }
  await click(byText(card(x, 'url'), '取消')); assert.deepEqual(x.posted.at(-1).result, { action: 'cancel', content: null, _meta: null });
  const tool = { ...params, requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'create_event', persist: ['session', 'always'] } };
  x.add({ id: 't', method: 'mcpServer/elicitation/request', params: tool });
  assert.equal(byText(card(x, 't'), '运行一次') !== undefined, true); assert.doesNotMatch(visibleText(card(x, 't')), /总是|会话中记住/);
  await click(byText(card(x, 't'), '运行一次')); assert.deepEqual(x.posted.at(-1).result, { action: 'accept', content: {}, _meta: null });
  assert.throws(() => formResponse(params, { tags: ['z'] }));
});

test('unsupported request is only explicitly rejected with -32601; other-thread requests are labelled', async () => {
  const x = setup(); x.add({ id: 'z', method: 'item/tool/call', params: { threadId: 'thread-b' } });
  const node = card(x, 'z'); assert.match(visibleText(node), /来自另一个对话：thread-b/);
  await click(byText(node, '拒绝此请求')); assert.deepEqual(x.posted[0], { id: 'z', bridgeRequestToken: 'token-"z"', error: { code: -32601 } });
});

test('required multi-select minItems 0: nothing checked sends []; aliases render the real form', async () => {
  const x = setup();
  x.add({ id: 'mi', method: 'mcpServer/elicitation/request', params: { threadId, turnId, serverName: 'svc', mode: 'openaiForm', message: 'Pick', requestedSchema: { type: 'object', required: ['choices'], properties: { choices: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 0 } } } } });
  const node = card(x, 'mi'); assert.equal(inputs(node, 'checkbox').length, 2);
  await click(byText(node, '发送表单给此服务'));
  assert.deepEqual(x.posted[0].result, { action: 'accept', content: { choices: [] }, _meta: null });
  x.add({ id: 'al', method: 'mcpServer/elicitation/request', params: { threadId, turnId, serverName: 'svc', mode: 'openai/form', message: 'Name', requestedSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } });
  inputs(card(x, 'al'), 'text')[0].value = 'alias form'; await click(byText(card(x, 'al'), '发送表单给此服务'));
  assert.deepEqual(x.posted[1].result, { action: 'accept', content: { name: 'alias form' }, _meta: null });
});

test('unknown codex_approval_kind with a fillable form offers only decline/cancel', async () => {
  const x = setup();
  x.add({ id: 'pk', method: 'mcpServer/elicitation/request', params: { threadId, turnId, serverName: 'svc', mode: 'form', message: 'Auth', _meta: { codex_approval_kind: 'browser_auth' }, requestedSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } });
  const node = card(x, 'pk');
  assert.equal(inputs(node).length, 0, 'no inputs invite filling'); assert.equal(byText(node, '发送表单给此服务'), undefined);
  await click(byText(node, '取消')); assert.deepEqual(x.posted[0].result, { action: 'cancel', content: null, _meta: null });
});

test('request text: label states truncation; long command and full raw text are shown, not cut at 16K', () => {
  const x = setup(); const long = 'x'.repeat(50000);
  x.add({ id: 'lc', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'c', command: long } });
  const node = card(x, 'lc');
  assert.ok(all(node).some(child => child.tag === 'pre' && child.textContent === long), 'command shown in full');
  const raw = all(node).find(child => child.classList.contains('approval-raw')), summary = raw.children[0], pre = raw.children[1];
  assert.equal(summary.textContent, '请求原文'); assert.doesNotMatch(visibleText(node), /完整请求详情/);
  raw.open = true; assert.ok(pre.textContent.includes(long), 'raw JSON contains the whole command');
  x.add({ id: 'huge', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'h', command: 'y'.repeat(300000) } });
  const hugeRaw = all(card(x, 'huge')).find(child => child.classList.contains('approval-raw'));
  assert.match(hugeRaw.children[0].textContent, /只显示前 262144 字符/);
});

test('modern fileChange: shows correlated files and diff, or states they were not loaded', () => {
  let material = { reason: '对话中还没有收到这次修改' };
  const x = setup(); x.deps.lookupFileChange = (thread, itemId) => { assert.equal(thread, threadId); assert.equal(itemId, 'fc'); return material; };
  x.add({ id: 'f1', method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'fc' } });
  const node = card(x, 'f1');
  assert.match(visibleText(node), /没有载入这次要修改的文件和内容（对话中还没有收到这次修改）/);
  assert.equal(byText(node, '仍然允许这一次') !== undefined, true, 'accept label says material is missing');
  material = { changes: [{ path: 'C:\\w\\a.md', kind: { type: 'update', move_path: null }, diff: '-old\n+new' }, { path: 'C:\\w\\b.md', kind: { type: 'add' }, diff: '+b' }] };
  x.deps.rerender();
  assert.equal(card(x, 'f1'), node, 'same card updated in place');
  assert.match(visibleText(node), /C:\\w\\a\.md · 修改/); assert.match(visibleText(node), /C:\\w\\b\.md · 新增/);
  const diff = all(node).find(child => child.classList.contains('approval-diff')); diff.open = true;
  assert.equal(diff.children[1].textContent, '-old\n+new');
  assert.ok(byText(node, '仅允许这一次')); assert.doesNotMatch(visibleText(node), /没有载入/);
  const y = setup(); y.add({ id: 'f2', method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'fc' } });
  assert.match(visibleText(card(y, 'f2')), /没有载入这次要修改的文件和内容/, 'no lookup available is stated too');
  y.add({ id: 'lp', method: 'applyPatchApproval', params: { conversationId: threadId, callId: 'c', fileChanges: { 'C:\\w\\c.md': { type: 'update', unified_diff: '-1\n+2' } } } });
  const legacyDiff = all(card(y, 'lp')).find(child => child.classList.contains('approval-diff')); legacyDiff.open = true; assert.equal(legacyDiff.children[1].textContent, '-1\n+2');
});

test('switching conversation re-scopes existing cards without losing drafts', () => {
  const x = setup();
  x.add(ask('sc', [{ id: 'a', header: 'A', question: 'Free', options: null }]));
  const node = card(x, 'sc'), area = all(node).find(child => child.tag === 'textarea'); area.value = 'kept draft';
  const scope = () => all(node).find(child => child.tag === 'p' && child.classList.contains('approval-scope') && /另一个对话/.test(child.textContent || ''));
  assert.equal(scope(), undefined);
  x.deps.currentThreadId = null; x.deps.rerender();
  assert.equal(card(x, 'sc'), node); assert.match(scope().textContent, /来自另一个对话：thread-a/); assert.equal(scope().hidden, false);
  x.deps.currentThreadId = 'thread-new'; x.deps.rerender(); assert.equal(scope().hidden, false);
  x.deps.currentThreadId = threadId; x.deps.rerender();
  assert.ok(!scope() || scope().hidden); assert.equal(area.value, 'kept draft');
});

test('same-length diff replacement re-renders; unchanged material keeps the preview node', () => {
  let material = { changes: [{ path: 'C:\\w\\a.md', kind: { type: 'update' }, diff: '-old\n+abc' }] };
  const x = setup(); x.deps.lookupFileChange = () => material;
  x.add({ id: 'sl', method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'fc' } });
  const node = card(x, 'sl'), first = all(node).find(child => child.classList.contains('approval-diff'));
  material = { changes: [{ path: 'C:\\w\\a.md', kind: { type: 'update' }, diff: '-old\n+abc' }] }; x.deps.rerender();
  assert.equal(all(node).find(child => child.classList.contains('approval-diff')), first, 'equal content keeps the open/closed diff');
  material = { changes: [{ path: 'C:\\w\\a.md', kind: { type: 'update' }, diff: '-old\n+xyz' }] }; x.deps.rerender();
  const second = all(node).find(child => child.classList.contains('approval-diff'));
  assert.notEqual(second, first); second.open = true; assert.equal(second.children[1].textContent, '-old\n+xyz');
});

test('modern missing/truncated file copy never points at request text; legacy still may', () => {
  let material = null;
  const x = setup(); x.deps.lookupFileChange = () => material;
  x.add({ id: 'm1', method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'fc' } });
  const text = () => visibleText(card(x, 'm1'));
  assert.match(text(), /请求原文只包含请求标识，看不到具体修改；无法核对时请拒绝/); assert.doesNotMatch(text(), /在请求原文中核对|见请求原文/);
  material = { truncated: true, changes: [{ path: 'C:\\w\\a.md', kind: { type: 'update' }, diff: '-1\n+2' }] }; x.deps.rerender();
  assert.match(text(), /请求原文不包含这些修改/); assert.doesNotMatch(text(), /见请求原文|完整内容见请求原文/);
  x.add({ id: 'm2', method: 'item/fileChange/requestApproval', params: { threadId, turnId } });
  assert.match(visibleText(card(x, 'm2')), /请求没有提供关联的修改内容。请求原文只包含请求标识/);
  x.add({ id: 'lg', method: 'applyPatchApproval', params: { conversationId: threadId, callId: 'c', fileChanges: {} } });
  assert.match(visibleText(card(x, 'lg')), /请求没有列出要修改的文件，无法核对具体修改/); assert.doesNotMatch(visibleText(card(x, 'lg')), /在请求原文中核对/);
});
