import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from './mini-dom.mjs';
import { mountDshConfig, configureBody, sharedProviders, effectiveMode } from '../public/ui/dsh-config-view.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const source = (id, extra = {}) => ({ id, label: id.split(':').pop(), path: 'C:/dsh/profiles/' + id + '/cordis.patch.yml', kind: 'profile', selected: false, valid: true, hash: 'abcdef0123456789', modifiedAt: '2026-11-12T06:00:00Z', providers: [{ id: 'p-' + id, api: 'openai-responses', baseURL: 'https://host/v1', modelCount: 2 }], error: null, ...extra });
const status = (over = {}) => ({ available: true, revision: 'r1', autoFollow: true, selectedSourceIds: ['profile:desktop'], sources: [source('profile:desktop', { selected: true }), source('profile:work'), source('custom:bad', { kind: 'custom', valid: false, error: { code: 'INVALID', message: '包含 inline secret，已拒绝' }, providers: [] })], effective: { revision: 'snap123456789', generatedAt: '2026-11-12T06:01:00Z', sourceIds: ['profile:desktop'], sourceHashes: {}, providerCount: 1 }, drift: false, error: null, activation: { state: 'pendingRestart', restartRequired: true }, policy: 'new-runtime-only', ...over });
function harness(responses) {
  const document = createDocument(); const host = document.createElement('div'); const calls = [];
  const api = async (path, body) => { calls.push([path, structuredClone(body)]); const next = responses.shift(); if (next instanceof Error) throw next; return next; };
  const view = mountDshConfig(host, { api });
  const buttons = () => host.querySelectorAll('button'); const byText = text => buttons().find(b => b.textContent === text);
  const boxes = () => host.querySelectorAll('input').filter(i => i.type === 'checkbox' && !i.classList.contains('switch'));
  return { host, view, calls, byText, boxes, toggle: () => host.querySelectorAll('input').find(i => i.classList.contains('switch')) };
}

test('pendingRestart is stated explicitly; saving never claims the running bridge changed', async () => {
  const h = harness([status(), status({ revision: 'r2', selectedSourceIds: ['profile:desktop', 'profile:work'] })]);
  h.view.activate(); await settle();
  const text = h.host.textContent;
  assert.match(text, /待重启生效/); assert.match(text, /当前运行的 DSH 桥尚未加载此功能/); assert.match(text, /仅影响之后新建的 runtime/);
  assert.match(text, /包含 inline secret，已拒绝/); assert.doesNotMatch(text, /apiKey|Authorization|headers/i);
  assert.equal(h.boxes()[2].disabled, true, 'an invalid source cannot be newly selected');
  assert.equal(h.byText('保存选择').disabled, true, 'nothing to save before a change');
  h.boxes()[1].checked = true; h.boxes()[1].dispatch('change');
  assert.match(h.host.textContent, /\d 个来源/);
  h.byText('保存选择').click(); await settle();
  assert.deepEqual(h.calls[1], ['/api/dsh/config-sources/configure', { sourceIds: ['profile:desktop', 'profile:work'], autoFollow: true, expectedRevision: 'r1' }]);
  assert.match(h.host.textContent, /已保存配置；重启 DSH 桥后才会对新 runtime 生效/);
  assert.doesNotMatch(h.host.textContent, /已生效/);
});
test('active state, drift with autoFollow off, and manual snapshot refresh', async () => {
  const h = harness([status({ activation: { state: 'active', restartRequired: false }, autoFollow: false, drift: true }), status({ activation: { state: 'active' }, autoFollow: false })]);
  h.view.activate(); await settle();
  assert.match(h.host.textContent, /已启用/); assert.match(h.host.textContent, /自动跟随已关闭：新 runtime 仍使用冻结快照/);
  assert.equal(h.toggle().checked, false);
  h.byText('立即更新快照').click(); await settle();
  assert.deepEqual(h.calls[1], ['/api/dsh/config-sources/refresh', {}]);
  assert.match(h.host.textContent, /快照已更新；只影响之后新建的 runtime/);
});
test('provider conflict and revision conflict are shown, not retried; revision conflict re-reads status', async () => {
  const conflict = Object.assign(new Error('provider p-x 内容冲突'), { code: 'SOURCE_CONFLICT', outcome: 'notExecuted' });
  const stale = Object.assign(new Error('配置版本已变化'), { code: 'REVISION_CONFLICT', outcome: 'notExecuted' });
  const h = harness([status(), conflict, stale, status({ revision: 'r9' })]);
  h.view.activate(); await settle();
  h.boxes()[1].checked = true; h.boxes()[1].dispatch('change'); h.byText('保存选择').click(); await settle();
  assert.match(h.host.textContent, /内容冲突/); assert.match(h.host.textContent, /只保留其一/);
  assert.equal(h.calls.filter(c => c[0].endsWith('/configure')).length, 1, 'no automatic resubmission');
  h.byText('保存选择').click(); await settle(); await settle();
  assert.equal(h.calls.at(-1)[0], '/api/dsh/config-sources/status', 'revision conflict reloads status');
});
test('register sends only the path and does not select it', async () => {
  const h = harness([status(), status({ sources: [...status().sources, source('custom:x', { kind: 'custom' })] })]);
  h.view.activate(); await settle();
  const input = h.host.querySelectorAll('input').find(i => i.getAttribute('aria-label') === '自定义配置文件路径');
  input.value = 'D:/cfg/cordis.patch.yml'; h.host.querySelector('form').dispatch('submit');
  await settle();
  assert.deepEqual(h.calls[1], ['/api/dsh/config-sources/register', { path: 'D:/cfg/cordis.patch.yml' }]);
  assert.equal(h.boxes().at(-1).checked, false); assert.match(h.host.textContent, /勾选后保存才会使用/);
});
test('selection rules and shared providers', () => {
  const s = status();
  assert.deepEqual(configureBody(s, { selected: new Set(), autoFollow: true }), { body: { sourceIds: [], autoFollow: true, expectedRevision: 'r1' } }, 'empty selection = built-in only, not an error');
  assert.match(configureBody(s, { selected: new Set(['custom:bad']), autoFollow: true }).error, /无效/);
  const many = { ...s, sources: Array.from({ length: 9 }, (_, i) => source('p:' + i)) };
  assert.match(configureBody(many, { selected: new Set(many.sources.map(x => x.id)), autoFollow: true }).error, /最多选择 8/);
  const twin = { ...s, sources: [source('a', { providers: [{ id: 'same' }] }), source('b', { providers: [{ id: 'same' }] })] };
  assert.deepEqual(sharedProviders(twin, new Set(['a', 'b'])), [{ id: 'same', owners: ['a', 'b'] }]);
});
test('unavailable bridge shows the backend reason and no controls', async () => {
  const h = harness([{ available: false, error: { message: '未安装 DSH 桥' }, sources: [], selectedSourceIds: [] }]);
  h.view.activate(); await settle();
  assert.match(h.host.textContent, /未安装 DSH 桥/); assert.equal(h.byText('保存选择'), undefined);
});
const builtinRadio = h => h.host.querySelectorAll('input').find(i => i.type === 'radio');
test('built-in only: deselecting every source saves sourceIds [] instead of demanding a source', async () => {
  const h = harness([status(), status({ revision: 'r2', selectedSourceIds: [], effective: { revision: 'snapB', generatedAt: '2026-11-12T07:00:00Z', sourceIds: [], mode: 'builtin', sourceHashes: {}, providerCount: 0 } })]);
  h.view.activate(); await settle();
  assert.match(h.host.textContent, /内置 provider \+ 所选来源导入/);
  assert.equal(builtinRadio(h).checked, false);
  h.boxes()[0].checked = false; h.boxes()[0].dispatch('change');
  assert.equal(builtinRadio(h).checked, true, 'empty selection is shown as the built-in-only choice');
  assert.equal(h.byText('保存选择').disabled, false);
  h.byText('保存选择').click(); await settle();
  assert.deepEqual(h.calls[1], ['/api/dsh/config-sources/configure', { sourceIds: [], autoFollow: true, expectedRevision: 'r1' }]);
  assert.doesNotMatch(h.host.textContent, /至少选择/);
  assert.match(h.host.textContent, /已保存为仅使用内置模型；重启 DSH 桥后才会对新 runtime 生效/);
  assert.match(h.host.textContent, /仅 DSH 内置 provider（不额外导入）/);
  assert.equal(h.host.querySelector('.dshcfg-activation').dataset.mode, 'builtin');
  assert.equal(h.byText('立即更新快照').disabled, true, 'no source file to re-read');
});
test('choosing the built-in option clears a multi-source draft in one step; picking a source leaves it', async () => {
  const h = harness([status({ selectedSourceIds: ['profile:desktop', 'profile:work'] })]);
  h.view.activate(); await settle();
  builtinRadio(h).checked = true; builtinRadio(h).dispatch('change');
  assert.deepEqual(h.boxes().map(b => b.checked), [false, false, false]);
  h.boxes()[1].checked = true; h.boxes()[1].dispatch('change');
  assert.equal(builtinRadio(h).checked, false);
});
test('a fresh install (no sources, builtin effective mode) is usable and shows the built-in state', async () => {
  const h = harness([status({ selectedSourceIds: [], sources: [], effective: { revision: 'snap0', generatedAt: '2026-11-12T06:00:00Z', sourceIds: [], mode: 'builtin', providerCount: 0 } })]);
  h.view.activate(); await settle();
  assert.equal(builtinRadio(h).checked, true);
  assert.match(h.host.textContent, /仅使用 DSH 内置模型/); assert.match(h.host.textContent, /可只使用内置模型/);
  assert.doesNotMatch(h.host.textContent, /个导入 provider/);
});
test('a broken explicitly selected source still reports its backend error and blocks saving it', async () => {
  const bad = source('custom:gone', { kind: 'custom', selected: true, valid: false, error: { code: 'SOURCE_MISSING', message: '配置文件不存在' }, providers: [] });
  const h = harness([status({ selectedSourceIds: ['custom:gone'], sources: [bad], error: { code: 'SOURCE_MISSING', message: '所选来源无法读取，新 DSH runtime 不会启动' } })]);
  h.view.activate(); await settle();
  assert.match(h.host.textContent, /配置文件不存在/); assert.match(h.host.textContent, /新 DSH runtime 不会启动/);
  assert.equal(builtinRadio(h).checked, false, 'a broken selection is not presented as built-in');
  h.toggle().checked = false; h.toggle().dispatch('change');
  h.byText('保存选择').click(); await settle();
  assert.match(h.host.textContent, /所选来源无效：gone/); assert.equal(h.calls.length, 1, 'not submitted');
  builtinRadio(h).checked = true; builtinRadio(h).dispatch('change');
  assert.deepEqual(configureBody(h.view.snapshot().status, h.view.snapshot().draft).body.sourceIds, [], 'recovering to built-in only is allowed');
});
test('effectiveMode prefers the backend mode and falls back to the snapshot or selection', () => {
  assert.equal(effectiveMode({ effective: { mode: 'imports', sourceIds: [] } }), 'imports');
  assert.equal(effectiveMode({ effective: { sourceIds: [] } }), 'builtin');
  assert.equal(effectiveMode({ effective: null, selectedSourceIds: ['a'] }), 'imports');
  assert.equal(effectiveMode({ effective: null, selectedSourceIds: [] }), 'builtin');
});
