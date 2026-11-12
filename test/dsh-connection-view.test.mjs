import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from './mini-dom.mjs';
import { mountDshConnection, describeConnection } from '../public/ui/dsh-connection-view.js';

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const status = (over = {}) => ({ bundled: { available: true, version: '0.8.0-light.1', dependenciesReady: true }, dsh: { installed: true, executablePath: 'C:/Apps/DeepSeek Harness/DeepSeek Harness.exe' }, registration: { state: 'none', serverName: 'dsh_subagent' }, runtime: { state: null }, canConnect: true, error: null, ...over });
const bundled = runtime => status({ registration: { state: 'bundled', serverName: 'dsh_subagent' }, runtime: { state: runtime }, canConnect: false });
const fail = (code, message, outcome = 'notExecuted') => Object.assign(new Error(message), { code, outcome });

function harness(responses, opts = {}) {
  const document = createDocument(); const host = document.createElement('div'); const calls = []; let changes = 0;
  const api = async (path, body) => { calls.push([path, structuredClone(body)]); const next = responses.shift(); if (!next) throw new Error('unexpected call ' + path); if (next instanceof Error) throw next; return next; };
  const view = mountDshConnection(host, { api, wait: async () => {}, followUps: 2, onChange: () => changes++, ...opts });
  const byText = text => host.querySelectorAll('button').find(b => b.textContent === text);
  return { host, view, calls, byText, changes: () => changes, paths: () => calls.map(([path]) => path) };
}

test('one click runs plan then connect once; registered and queued are not shown as connected', async () => {
  const h = harness([status(), { planId: 'p1', serverName: 'dsh_subagent', scope: 'user', preservesExisting: true, dsh: { executablePath: 'x' } },
    { registered: true, registration: { state: 'bundled', serverName: 'dsh_subagent' }, reload: { queued: true, error: null }, runtime: { state: null }, warning: null },
    bundled(null), bundled('starting'), bundled('starting')]);
  h.view.activate(); await settle();
  assert.match(h.host.textContent, /未连接/); assert.match(h.host.textContent, /mcp_servers\.dsh_subagent/);
  h.byText('连接 DSH').click(); h.byText('正在连接…')?.click(); await settle();
  assert.deepEqual(h.paths().slice(0, 3), ['/api/dsh/connection/status', '/api/dsh/connection/plan', '/api/dsh/connection/connect']);
  assert.equal(h.paths().filter(p => p.endsWith('/connect')).length, 1, 'a double click never connects twice');
  assert.deepEqual(h.calls[2][1], { planId: 'p1', confirmed: true });
  const text = h.host.textContent;
  assert.match(text, /已注册，尚未确认连接/); assert.match(text, /已排队（不等于已连接）/); assert.match(text, /正在启动/);
  assert.doesNotMatch(text, /随包桥已在 Codex 中注册并连接/);
  assert.equal(h.paths().filter(p => p.endsWith('/status')).length, 4, 'runtime status is re-read a bounded number of times');
  assert.equal(h.changes(), 1);
});

test('the runtime connected state comes only from status', () => {
  assert.equal(describeConnection(bundled('connected')).label, '已连接');
  assert.equal(describeConnection(bundled(null), { reload: { queued: true } }).label, '已注册，尚未确认连接');
  assert.match(describeConnection(bundled(null), { reload: { queued: false, error: { message: 'old' } } }).detail, /重新打开会话/);
  assert.equal(describeConnection(bundled('failed')).tone, 'fail');
});

test('an existing external MCP is kept; no connect or replace action is offered', async () => {
  const h = harness([status({ registration: { state: 'external', serverName: 'dsh_subagent' }, runtime: { state: 'connected' }, canConnect: false })]);
  h.view.activate(); await settle();
  assert.match(h.host.textContent, /使用已有配置/); assert.match(h.host.textContent, /已保留/);
  assert.equal(h.byText('连接 DSH'), undefined);
  assert.doesNotMatch(h.host.textContent, /替换|覆盖已有/);
});

test('missing DSH is optional: path input is required and sent only when DSH was not detected', async () => {
  const h = harness([status({ dsh: { installed: false, executablePath: null } }), fail('INVALID_EXECUTABLE', '不是 DSH 本体', 'notExecuted'), status({ dsh: { installed: false, executablePath: null } })]);
  h.view.activate(); await settle();
  assert.match(h.host.textContent, /不影响普通聊天/);
  assert.equal(h.byText('连接 DSH').disabled, true);
  const input = h.host.querySelectorAll('input')[0]; input.value = 'D:/DSH/DeepSeek Harness.exe'; input.dispatch('input');
  assert.equal(h.byText('连接 DSH').disabled, false);
  h.byText('连接 DSH').click(); await settle();
  assert.deepEqual(h.calls[1], ['/api/dsh/connection/plan', { executablePath: 'D:/DSH/DeepSeek Harness.exe' }]);
  assert.equal(h.paths().includes('/api/dsh/connection/connect'), false, 'a failed plan never continues to connect or retries');
  assert.match(h.host.textContent, /不是 DSH 本体/);
});

test('plan conflict for an existing config is stated without retry', async () => {
  const h = harness([status(), fail('MCP_ALREADY_CONFIGURED', '已存在 DSH MCP 配置，已保留，不会覆盖'), status({ registration: { state: 'external', serverName: 'dsh_subagent' }, canConnect: false })]);
  h.view.activate(); await settle(); h.byText('连接 DSH').click(); await settle();
  assert.deepEqual(h.paths(), ['/api/dsh/connection/status', '/api/dsh/connection/plan', '/api/dsh/connection/status']);
  assert.match(h.host.textContent, /现有配置可继续使用/);
});

test('an unknown connect outcome is reported as unknown and never resent', async () => {
  const h = harness([status(), { planId: 'p2' }, fail('CONNECTION_OUTCOME_UNKNOWN', '配置写入结果需核对', 'unknown'), status()]);
  h.view.activate(); await settle(); h.byText('连接 DSH').click(); await settle();
  assert.equal(h.paths().filter(p => p.endsWith('/connect')).length, 1);
  assert.match(h.host.textContent, /连接结果未知/); assert.match(h.host.textContent, /不会自动重发/);
});

test('unavailable bundle or config limits only this feature', () => {
  assert.equal(describeConnection(status({ bundled: { available: false, dependenciesReady: false } })).action, null);
  assert.match(describeConnection(status({ error: { code: 'CODEX_CONFIG_UNAVAILABLE', message: '无法读取 Codex MCP 配置' } })).detail, /普通聊天不受影响/);
  assert.equal(describeConnection(status({ canConnect: false })).action, null);
});

test('the entry is local-only markup next to config sources', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="dsh-connection-root" class="local-only"><\/div>\s*<div id="dsh-config-root"/);
});
