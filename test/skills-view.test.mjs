import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, visibleText } from './mini-dom.mjs';
import { mountSkillsView, skillCatalog } from '../public/ui/skills-view.js';
import { createSlashMenu } from '../public/ui/slash-menu.js';
import { el } from '../public/ui/format.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const context = (cwd = '/project', extra = {}) => ({ cwd, projectless: !cwd, connected: true, serverInstance: 'a', runtimeTarget: 'native', ...extra });
const skill = (path, extra = {}) => ({ name: 'pdf', path, enabled: true, scope: 'user', ...extra });
const directory = (skills, cwd = '/project', errors = []) => ({ data: [{ cwd, skills, errors }] });
const repoPath = '/project/.agents/skills/pdf/SKILL.md';
const userPath = '/home/user/.agents/skills/pdf/SKILL.md';

function viewFixture(deps) {
  const document = createDocument();
  const host = document.createElement('section');
  document.body.append(host);
  const view = mountSkillsView(host, { pending: () => [], onCatalogChanged: () => {}, ...deps });
  return { document, view, host, toggles: () => host.querySelectorAll('[role="switch"]') };
}

test('settings shows same-name paths and partial discovery errors and applies effective state while preserving focus', async () => {
  const rows = [skill(repoPath, { scope: 'repo' }), skill(userPath, { enabled: false, interface: { displayName: 'PDF 工具' }, pluginId: 'documents@test' })];
  const errors = [{ path: '/project/bad/SKILL.md', message: '缺少描述' }];
  const writes = [];
  let refreshes = 0;
  let settle;
  const { document, view, host, toggles } = viewFixture({
    read: async () => directory(structuredClone(rows), '/project', errors),
    write: params => { writes.push(params); return new Promise(resolve => { settle = resolve; }); },
    onCatalogChanged: () => { refreshes++; },
  });
  assert.equal(skillCatalog(directory([...rows, rows[0]])).rows.size, 2);
  view.setContext(context());
  await view.activate();
  assert.equal(toggles().length, 2);
  assert.match(visibleText(host), /1 个技能读取失败.*缺少描述/);
  assert.match(visibleText(host), /插件 · documents@test/);
  assert.deepEqual(host.querySelectorAll('.skills-source').map(node => node.open), [true, true]);
  const search = host.querySelector('#skills-search');
  search.value = 'documents@test';
  search.dispatch('input');
  assert.equal(toggles().length, 1);
  search.value = '$pdf'; search.dispatch('input');
  assert.equal(toggles().length, 2);
  search.value = 'unmatched'; search.dispatch('input');
  assert.match(visibleText(host), /没有匹配的技能/);
  search.value = ''; search.dispatch('input');
  const [repo, user] = toggles();
  user.focus();
  user.click(); user.click();
  assert.equal(user.getAttribute('aria-disabled'), 'true');
  assert.equal(repo.getAttribute('aria-disabled'), 'false');
  assert.deepEqual(writes, [{ cwd: '/project', path: userPath, enabled: true }]);
  settle({ effectiveEnabled: false });
  await flush();
  assert.equal(user, document.activeElement);
  assert.equal(user.getAttribute('aria-checked'), 'false');
  assert.match(visibleText(host), /已停用/);
  assert.equal(refreshes, 1);

  rows[1].enabled = true;
  await view.invalidate();
  assert.equal(user.getAttribute('aria-checked'), 'true');
  assert.doesNotMatch(visibleText(host), /已停用/);
});

test('settings guards late reads of both the same cwd and different environments and distinguishes failure, empty and offline', async () => {
  const requests = [];
  const { view, host, toggles } = viewFixture({
    read: (cwd, options) => new Promise((resolve, reject) => requests.push({cwd, ...options, resolve, reject})),
  });
  view.setContext(context('/one'));
  const first = view.activate();
  const forced = view.invalidate();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].forceReload, true);
  const next = view.setContext(context('/two', { runtimeTarget: 'wsl' }));
  assert.equal(requests[1].signal.aborted, true);
  requests[2].resolve(directory([]));
  await next;
  requests[1].resolve(directory([skill(userPath)]));
  requests[0].resolve(directory([skill(repoPath)]));
  await Promise.all([first, forced]);
  assert.match(visibleText(host), /当前项目\/two.*未发现技能/);
  assert.equal(toggles().length, 0);
  const failed = view.invalidate();
  requests[3].reject(new Error('fixture failure'));
  await failed;
  assert.match(visibleText(host), /技能目录读取失败：fixture failure/);
  view.setContext(context('/two', { connected: false, runtimeTarget: 'wsl' }));
  assert.match(visibleText(host), /Codex 连接已断开/);
  const noProject = view.setContext(context(''));
  assert.equal(requests[4].cwd, '');
  requests[4].resolve(directory([], '/codex-session'));
  await noProject;
  assert.match(visibleText(host), /无项目 · Codex 会话目录\/codex-session/);
});

test('an unknown skill update only reads back the state and holds its row until reconciliation', async () => {
  const calls = [];
  const records = [];
  let rows = [skill(repoPath), skill(userPath)];
  const { view, host, toggles } = viewFixture({
    pending: () => records,
    read: async (cwd, { forceReload }) => {
      calls.push({ cwd, forceReload });
      return directory(structuredClone(rows));
    },
    write: async params => {
      calls.push(params);
      records.push({ requestId: 'fixture', path: params.path });
      throw new Error('request interrupted');
    },
  });
  view.setContext(context());
  await view.activate();
  const [repo, user] = toggles();
  repo.click();
  await flush();
  assert.deepEqual(calls, [
    { cwd: '/project', forceReload: false },
    { cwd: '/project', path: repoPath, enabled: false },
    { cwd: '/project', forceReload: true },
  ]);
  assert.equal(repo.getAttribute('aria-disabled'), 'true');
  assert.equal(user.getAttribute('aria-disabled'), 'false');
  assert.match(visibleText(host), /正在核对更新结果/);
  rows[0].enabled = false;
  records.length = 0;
  view.recover(repoPath, { effectiveEnabled: false }, 'succeeded');
  await flush();
  assert.equal(repo.getAttribute('aria-checked'), 'false');
  assert.equal(repo.getAttribute('aria-disabled'), 'false');
  assert.match(visibleText(host), /已停用/);
  assert.equal(calls.filter(call => 'enabled' in call).length, 1);
});

test('composer discards invalidated same-cwd requests and loads skills for a projectless draft', async () => {
  const document = createDocument();
  const prompt = document.createElement('textarea');
  const menu = document.createElement('div');
  document.body.append(prompt, menu);
  prompt.value = '/pdf';
  prompt.selectionStart = 4;
  let scope = context('');
  const requests = [];
  const slash = createSlashMenu({
    document, prompt, menu, el: (...args) => el(document, ...args),
    readSkills: (cwd, options) => new Promise(resolve => requests.push({ cwd, ...options, resolve })),
    context: () => scope,
    commands: {},
    onDraftChange() {},
  });
  slash.update();
  assert.equal(requests[0].cwd, '');
  slash.invalidateSkills();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].forceReload, true);
  requests[1].resolve(directory([skill(repoPath, { enabled: false }), skill(userPath)]));
  await flush();
  assert.deepEqual(slash.snapshot().entries.map(entry => entry.label), ['$pdf']);
  requests[0].resolve(directory([]));
  await flush();
  assert.deepEqual(slash.snapshot().entries.map(entry => entry.label), ['$pdf']);
  scope = context('/wsl', { serverInstance: 'b', runtimeTarget: 'wsl' });
  slash.syncContext();
  assert.equal(requests[2].cwd, '/wsl');
  assert.equal(slash.snapshot().entries.length, 0);
});
