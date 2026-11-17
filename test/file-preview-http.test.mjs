import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from '../src/server.mjs';
const address = '192.168.74.20';
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'file-preview-http-')), root = path.join(parent, 'project'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, '测试.txt'), 'first\n第二行'); await fs.writeFile(path.join(parent, 'outside.txt'), 'outside');
  const app = await createServer({demo: true, cwd: root, projectStore: {list: async () => ({projects: [{id: 'project', path: root}], selectedId: 'project'}), queue: Promise.resolve()}, lanOptions: {networkInterfaces: () => ({Synthetic: [{address, family: 'IPv4', internal: false}]}), serverFactory: handler => {
    const server = http.createServer(handler), listen = server.listen.bind(server); server.listen = options => listen({...options, host: '127.0.0.1'}); return server;
  }}});
  await app.started; t.after(async () => {await app.close(); await fs.rm(parent, {recursive: true, force: true});}); return {app, root};
}
const post = (app, input, headers = {}) => fetch(app.origin + '/api/files/preview', {method: 'POST', headers: {Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json', ...headers}, body: JSON.stringify(input)});

test('file preview HTTP requires bearer and same origin; errors never include file contents', async t => {
  const {app} = await fixture(t), input = {projectId: 'project', path: '测试.txt', line: 2};
  assert.equal((await post(app, input, {Authorization: ''})).status, 401);
  assert.equal((await post(app, input, {Origin: 'https://outside.invalid'})).status, 403);
  const response = await post(app, input); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^application\/json/); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await response.json()).text, 'first\n第二行');
  const outside = await post(app, {projectId: 'project', path: '../outside.txt'}); assert.equal(outside.status, 200); assert.equal((await outside.json()).text, 'outside');
  const denied = await post(app, {path: String.raw`\\server.invalid\share\file.txt`}); assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'FILE_PREVIEW_NETWORK_REFUSED');
});

test('opening a trusted RPC thread supplies the base for relative links', async t => {
  const {app, root} = await fixture(t);
  assert.equal((await post(app, {threadId: 'invented', path: '测试.txt'})).status, 403);
  const response = await fetch(app.origin + '/api/rpc', {method: 'POST', headers: {Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json'}, body: JSON.stringify({method: 'thread/start', params: {cwd: root}, requestId: app.operations.serverInstance + ':' + Date.now() + ':file-preview-start'})});
  assert.equal(response.status, 200); const {thread} = await response.json();
  const preview = await post(app, {threadId: thread.id, path: path.join(root, '测试.txt')}); assert.equal(preview.status, 200); assert.equal((await preview.json()).text, 'first\n第二行');
});

test('LAN capability can preview both project and explicitly linked outside local files', async t => {
  const {app, root} = await fixture(t), lan = await app.lan.enable({address});
  const token = new URLSearchParams(new URL(lan.url).hash.slice(1)).get('token');
  const request = (input, auth = token) => new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    const req = http.request({hostname: '127.0.0.1', port: lan.port, method: 'POST', path: '/api/files/preview', headers: {Host: new URL(lan.origin).host, Origin: lan.origin, Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}}, response => {const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({status: response.statusCode, json: JSON.parse(Buffer.concat(chunks))})); response.on('error', reject);});
    req.on('error', reject); req.end(body);
  });
  const result = await request({projectId: 'project', path: '测试.txt'}); assert.equal(result.status, 200); assert.equal(result.json.text, 'first\n第二行');
  assert.equal((await request({projectId: 'project', path: '测试.txt'}, app.token)).status, 401);
  const outside = await request({projectId: 'project', path: '../outside.txt'}); assert.equal(outside.status, 200); assert.equal(outside.json.text, 'outside');
  const absolute = await request({path: path.join(root, '..', 'outside.txt')}); assert.equal(absolute.status, 200); assert.equal(absolute.json.text, 'outside');
  assert.equal((await request({path: String.raw`\\server.invalid\share\file.txt`})).status, 403);
});
