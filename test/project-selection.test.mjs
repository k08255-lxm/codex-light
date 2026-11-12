import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { projectPathKey } from '../public/projects.js';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = app.indexOf('async function loadProjects(');
const end = app.indexOf('async function loadThreads(', start);
assert.ok(start >= 0 && end > start, 'project functions must be available for the behavior harness');

const savedProject = { id: 'selected', path: '/canonical/new-project', name: 'New project' };
const savedResult = () => ({ projects: [savedProject], selectedId: savedProject.id, canPickFolder: true });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness(options = {}) {
  const originalThread = Object.freeze({ id: 'original-thread', cwd: '/original-project' });
  const state = { cwd: originalThread.cwd, thread: originalThread, openGeneration: 3, loadingThread: false, sending: false, ...options.state };
  const projectsState = { projects: [], selectedId: null, canPickFolder: true, busy: false, error: '', generation: 0, dialogGeneration: 4, ...options.projectsState };
  const calls = { api: [], navigation: [], renders: [], notices: [], closeSettings: 0, dialogClose: 0, focuses: [] };
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, {
      open: false, disabled: false, textContent: '',
      classList: { add() {}, remove() {}, toggle() {} },
      focus() { calls.focuses.push(id); },
      close() { this.open = false; projectsState.dialogGeneration++; calls.dialogClose++; },
    });
    return nodes.get(id);
  };
  $('project-dialog').open = options.dialogOpen === true;
  const functions = runInNewContext(`${app.slice(start, end)}\n({loadProjects, saveProjectSelection, selectProject, addProject});`, {
    state, projectsState, $, projectPathKey,
    api: async (...args) => {
      calls.api.push(args);
      return options.api ? options.api(...args) : savedResult();
    },
    renderThreads() { calls.renders.push({ busy: projectsState.busy, projects: projectsState.projects, error: projectsState.error }); },
    notice: (...args) => calls.notices.push(args),
    newThread() {
      calls.navigation.push(['newThread']);
      state.openGeneration++; state.thread = null; state.loadingThread = false;
    },
    setCwd(path) {
      calls.navigation.push(['setCwd', path, state.thread?.id || null, state.loadingThread]);
      state.cwd = path;
    },
    closeSettings() { calls.closeSettings++; },
  }, { filename: 'app-project-functions.js' });
  return { ...functions, state, projectsState, originalThread, calls, $ };
}

test('saving a different project creates a fresh page before setting its canonical cwd', async () => {
  const h = harness({ dialogOpen: true });
  await h.saveProjectSelection({ path: '/requested-project' }, h.state.openGeneration, h.projectsState.dialogGeneration);
  assert.equal(h.calls.api[0][0], '/api/projects/add');
  assert.equal(h.calls.api[0][1].path, '/requested-project');
  assert.deepEqual(h.calls.navigation, [['newThread'], ['setCwd', savedProject.path, null, false]]);
  assert.equal(h.state.thread, null);
  assert.equal(h.originalThread.cwd, '/original-project', 'the prior thread must never be retargeted');
  assert.equal(h.state.cwd, savedProject.path);
  assert.equal(h.projectsState.selectedId, savedProject.id);
  assert.deepEqual(h.projectsState.projects, [savedProject]);
  assert.equal(h.calls.dialogClose, 1);
  assert.deepEqual(h.calls.focuses, ['prompt']);
});

test('selecting the same normalized cwd preserves an existing thread but cancels an unfinished thread load', async () => {
  const canonical = { projects: [{ id: 'same', path: 'C:\\WORK\\Project' }], selectedId: 'same' };
  for (const loadingThread of [false, true]) {
    const h = harness({ state: { cwd: 'c:/work/project/', loadingThread }, api: async () => canonical });
    await h.selectProject({ path: 'c:/work/project', projectId: 'same' });
    assert.equal(h.calls.api[0][0], '/api/projects/select');
    assert.equal(h.calls.api[0][1].id, 'same');
    if (loadingThread) {
      assert.deepEqual(h.calls.navigation, [['newThread'], ['setCwd', canonical.projects[0].path, null, false]]);
      assert.equal(h.state.thread, null);
      assert.equal(h.state.openGeneration, 4, 'newThread invalidates the outstanding resume response');
    } else {
      assert.deepEqual(h.calls.navigation, [['setCwd', canonical.projects[0].path, h.originalThread.id, false]]);
      assert.equal(h.state.thread, h.originalThread);
    }
    assert.equal(h.projectsState.busy, false);
    assert.equal(h.$('project-save').disabled, false);
    assert.equal(h.$('project-browse').disabled, false);
  }
});

test('late selection results update the sidebar without navigating after page, send or dialog changes', async t => {
  const changes = {
    'page generation changed': h => { h.state.openGeneration++; h.state.thread = { id: 'newer-thread', cwd: '/newer' }; },
    'a send started': h => { h.state.sending = true; },
    'dialog was closed or reopened': h => { h.projectsState.dialogGeneration++; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const response = deferred();
    const h = harness({ api: () => response.promise, dialogOpen: true });
    const pending = h.selectProject({ path: '/requested-project', projectId: 'selected' });
    assert.equal(h.projectsState.busy, true);
    change(h);
    const thread = h.state.thread;
    response.resolve(savedResult()); await pending;
    assert.deepEqual(h.projectsState.projects, [savedProject]);
    assert.equal(h.projectsState.selectedId, savedProject.id);
    assert.equal(h.projectsState.generation, 1);
    assert.equal(h.state.thread, thread);
    assert.equal(h.state.cwd, '/original-project');
    assert.deepEqual(h.calls.navigation, []);
    assert.equal(h.calls.dialogClose, 0);
    assert.equal(h.calls.focuses.length, 0);
    assert.match(h.calls.notices[0][0], /项目已保存到侧栏/);
    assert.equal(h.calls.renders.at(-1).projects, h.projectsState.projects);
    assert.equal(h.projectsState.busy, false);
  });
});

test('cancelling the native picker saves nothing, creates no thread and releases busy controls', async () => {
  const response = deferred();
  const h = harness({ api: () => response.promise });
  const pending = h.addProject();
  assert.equal(h.projectsState.busy, true);
  assert.equal(h.$('project-browse').disabled, true);
  assert.equal(h.calls.api[0][0], '/api/desktop/pick-folder');
  response.resolve({ path: null }); await pending;
  assert.equal(h.calls.api.length, 1, 'cancel must not call the project add endpoint');
  assert.deepEqual(h.calls.navigation, []);
  assert.equal(h.state.thread, h.originalThread);
  assert.equal(h.state.cwd, '/original-project');
  assert.deepEqual(h.projectsState.projects, []);
  assert.equal(h.projectsState.selectedId, null);
  assert.equal(h.projectsState.busy, false);
  assert.equal(h.$('project-save').disabled, false);
  assert.equal(h.$('project-browse').disabled, false);
  assert.deepEqual(h.calls.renders.map(render => render.busy), [true, false]);
});

test('selection and picker errors preserve the current page, expose the error and release busy in finally', async () => {
  for (const operation of ['selectProject', 'addProject']) {
    const h = harness({ api: async () => { throw new Error('Directory unavailable'); }, dialogOpen: true });
    await h[operation]({ path: '/unavailable', projectId: 'selected' });
    assert.deepEqual(h.calls.navigation, []);
    assert.equal(h.state.thread, h.originalThread);
    assert.equal(h.state.cwd, '/original-project');
    assert.equal(h.projectsState.error, 'Directory unavailable');
    assert.equal(h.$('project-status').textContent, 'Directory unavailable');
    assert.equal(h.calls.renders.some(render => render.error === 'Directory unavailable'), true);
    assert.equal(h.projectsState.busy, false);
    assert.equal(h.$('project-save').disabled, false);
    assert.equal(h.$('project-browse').disabled, false);
    assert.equal(h.calls.dialogClose, 0);
  }
  const closed = harness({ api: async () => { throw new Error('Unavailable'); } });
  await closed.selectProject({ path: '/unavailable' });
  assert.deepEqual(closed.calls.notices, [['Unavailable', true]]);
});

test('saved selection restores only into a page with neither cwd nor thread, and load errors never navigate', async () => {
  for (const state of [{ cwd: '', thread: null }, { cwd: '/already-chosen', thread: null }, { cwd: '', thread: { id: 'existing' } }]) {
    const h = harness({ state });
    await h.loadProjects({ restore: true });
    const shouldRestore = !state.cwd && !state.thread;
    assert.deepEqual(h.calls.navigation, shouldRestore ? [['setCwd', savedProject.path, null, false]] : []);
    assert.equal(h.projectsState.canPickFolder, true);
    assert.equal(h.projectsState.selectedId, savedProject.id);
  }
  const noRestore = harness({ state: { cwd: '', thread: null } });
  await noRestore.loadProjects(); assert.deepEqual(noRestore.calls.navigation, []);
  const failure = harness({ state: { cwd: '', thread: null }, api: async () => { throw new Error('Registry read failed'); } });
  await failure.loadProjects({ restore: true });
  assert.deepEqual(failure.calls.navigation, []);
  assert.equal(failure.projectsState.error, 'Registry read failed');
  assert.equal(failure.calls.renders.at(-1).error, 'Registry read failed');
});

test('an older project-list response cannot replace a newer list or restore an obsolete selection', async () => {
  const old = deferred(), latest = deferred();
  let request = 0;
  const h = harness({ state: { cwd: '', thread: null }, api: () => (++request === 1 ? old.promise : latest.promise) });
  const first = h.loadProjects({ restore: true });
  const second = h.loadProjects();
  const newList = { projects: [{ id: 'latest', path: '/latest' }], selectedId: 'latest', canPickFolder: false };
  latest.resolve(newList); await second;
  old.resolve(savedResult()); await first;
  assert.equal(h.projectsState.projects, newList.projects);
  assert.equal(h.projectsState.selectedId, 'latest');
  assert.equal(h.projectsState.canPickFolder, false);
  assert.deepEqual(h.calls.navigation, []);
  assert.equal(h.calls.renders.length, 1);
});
