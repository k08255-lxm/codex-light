import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../src/server.mjs';

async function fixture(t, options = {}) {
  const app = await createServer({demo: true, ...options});
  await app.started;
  t.after(() => app.close());
  return app;
}

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-routes-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

const request = (app, url, data, {auth = true, origin} = {}) => fetch(app.origin + url, {
  method: data === undefined ? 'GET' : 'POST',
  headers: {...(auth ? {Authorization: 'Bearer ' + app.token} : {}), 'Content-Type': 'application/json', ...(origin ? {Origin: origin} : {})},
  ...(data === undefined ? {} : {body: JSON.stringify(data)})
});

test('project and folder routes retain authentication and Origin gates', async t => {
  const app = await fixture(t, {desktop: true, onDesktopPickFolder: async () => null});
  for (const [url, data] of [['/api/projects', undefined], ['/api/projects/add', {path: process.cwd()}], ['/api/projects/select', {id: 'a'}], ['/api/projects/remove', {id: 'a'}], ['/api/desktop/pick-folder', {}]]) {
    assert.equal((await request(app, url, data, {auth: false})).status, 401, url);
    assert.equal((await request(app, url, data, {origin: 'https://evil.example'})).status, 403, url);
  }
  assert.equal((await request(app, '/api/projects')).status, 200);
});

test('project route parameters are strict and never create operation receipts', async t => {
  const app = await fixture(t);
  for (const [url, values] of [
    ['/api/projects/add', [{}, [], null, {path: 1}, {path: process.cwd(), extra: true}]],
    ['/api/projects/select', [{}, [], {id: 1}, {id: 'a', extra: true}]],
    ['/api/projects/remove', [{}, [], {id: 1}, {id: 'a', extra: true}]]
  ]) for (const value of values) assert.equal((await request(app, url, value)).status, 400, url + JSON.stringify(value));
  assert.equal((await app.projectStore.list()).projects.length, 0);
  assert.equal(app.operations.entries.size, 0);
});

test('add deduplicates; selection and remove preserve project files, chats and config', async t => {
  const root = await directory(t), first = path.join(root, 'first'), second = path.join(root, 'second');
  await Promise.all([mkdir(first), mkdir(second)]);
  await writeFile(path.join(first, 'keep.txt'), 'keep file');
  const app = await fixture(t, {cwd: root});
  const initial = await (await request(app, '/api/config')).json();
  const added = await (await request(app, '/api/projects/add', {path: first})).json();
  const duplicate = await (await request(app, '/api/projects/add', {path: path.join(first, '.')})).json();
  assert.equal(duplicate.projects.length, 1);
  assert.equal(duplicate.selectedId, added.selectedId);
  await request(app, '/api/projects/add', {path: second});
  const selected = await request(app, '/api/projects/select', {id: added.selectedId});
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).selectedId, added.selectedId);
  const requestId = `${app.operations.serverInstance}:${Date.now()}:project-chat-fixture`;
  const started = await request(app, '/api/rpc', {requestId, method: 'thread/start', params: {cwd: first, approvalPolicy: 'on-request', sandbox: 'workspace-write'}});
  assert.equal(started.status, 200);
  const {thread} = await started.json();
  const beforeOperations = app.operations.entries.size;
  const removed = await (await request(app, '/api/projects/remove', {id: added.selectedId})).json();
  assert.equal(removed.projects.length, 1);
  assert.equal(removed.selectedId, null);
  assert.equal(await readFile(path.join(first, 'keep.txt'), 'utf8'), 'keep file');
  assert.ok(app.rpc.threads.has(thread.id));
  assert.equal(app.operations.entries.size, beforeOperations);
  assert.deepEqual(await (await request(app, '/api/config')).json(), initial);
});

test('default demo project roots are isolated and removed at close', async t => {
  const first = await fixture(t), second = await fixture(t);
  assert.notEqual(first.projectStore.root, second.projectStore.root);
  await request(first, '/api/projects/add', {path: process.cwd()});
  assert.equal((await (await request(second, '/api/projects')).json()).projects.length, 0);
  const root = first.projectStore.root;
  await first.close();
  await assert.rejects(stat(root), {code: 'ENOENT'});
  assert.ok((await stat(second.projectStore.root)).isDirectory());
});

test('injected project store is used and its root survives server shutdown', async t => {
  const root = await directory(t), projectsRoot = path.join(root, 'state');
  const first = await fixture(t, {projectsRoot});
  await request(first, '/api/projects/add', {path: root});
  await first.close();
  assert.ok((await stat(projectsRoot)).isDirectory());
  const second = await fixture(t, {projectStore: first.projectStore});
  assert.equal((await (await request(second, '/api/projects')).json()).projects.length, 1);
  await second.close();
  assert.ok((await stat(projectsRoot)).isDirectory());
});

test('shutdown waits for the injected project store queue', async t => {
  let finish;
  const queue = new Promise(resolve => {finish = resolve;});
  const app = await fixture(t, {projectStore: {queue}});
  let closed = false;
  const closing = app.close().then(() => {closed = true;});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  finish();
  await closing;
  assert.equal(closed, true);
});

test('project and activity static modules are served from the explicit allowlist', async t => {
  const app = await fixture(t);
  for (const file of ['projects.js', 'project-navigation.js', 'project-navigation.css', 'activity-feed.js', 'activity-feed.css']) {
    const response = await fetch(app.origin + '/' + file);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-type'), file.endsWith('.css') ? /text\/css/ : /text\/javascript/);
  }
  assert.equal((await fetch(app.origin + '/src/projects.mjs')).status, 404);
});

test('folder picker returns selection or cancellation without changing project or config', async t => {
  let picked = null, calls = 0;
  const app = await fixture(t, {desktop: true, onDesktopPickFolder: async () => {calls++; return picked;}});
  assert.equal((await (await request(app, '/api/projects')).json()).canPickFolder, true);
  const initial = await (await request(app, '/api/config')).json();
  assert.deepEqual(await (await request(app, '/api/desktop/pick-folder', {})).json(), {path: null});
  picked = process.cwd();
  assert.deepEqual(await (await request(app, '/api/desktop/pick-folder', {})).json(), {path: picked});
  for (const value of [[], null, {extra: true}]) assert.equal((await request(app, '/api/desktop/pick-folder', value)).status, 400);
  assert.equal(calls, 2);
  assert.equal((await app.projectStore.list()).projects.length, 0);
  assert.deepEqual(await (await request(app, '/api/config')).json(), initial);
});

test('unsupported picker reports capability and callback output must be a valid absolute path', async t => {
  for (const options of [{}, {desktop: true}, {onDesktopPickFolder: async () => null}]) {
    const app = await fixture(t, options);
    assert.equal((await (await request(app, '/api/projects')).json()).canPickFolder, false);
    assert.equal((await request(app, '/api/desktop/pick-folder', {})).status, 409);
  }
  let picked;
  const app = await fixture(t, {desktop: true, onDesktopPickFolder: async () => picked});
  for (picked of [undefined, {}, '', 'relative', 'x'.repeat(4097), process.cwd() + '\0']) assert.equal((await request(app, '/api/desktop/pick-folder', {})).status, 400);
});
