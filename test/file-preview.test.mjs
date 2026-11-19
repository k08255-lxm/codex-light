import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {FilePreviewService, FILE_PREVIEW_LIMITS, FILE_DOWNLOAD_LIMIT} from '../src/file-preview.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'file-preview-')), root = path.join(parent, 'project'), outside = path.join(parent, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  const service = new FilePreviewService({projects: {list: async () => ({projects: [{id: 'project', path: root}]})}});
  service.bindThread({id: 'thread', cwd: root});
  t.after(async () => {await service.close(); await fs.rm(parent, {recursive: true, force: true});});
  return {service, root, outside};
}

test('registered projects and bound threads preview Chinese, spaced and URL paths with line selection', async t => {
  const {service, root} = await fixture(t), file = path.join(root, '测试 文档.md');
  await fs.writeFile(file, '第一行\r\n第二行\r\n<script>not executed</script>');
  for (const input of [{projectId: 'project', path: '测试 文档.md'}, {threadId: 'thread', path: file}, {threadId: 'thread', path: pathToFileURL(file).href}]) {
    const result = await service.preview({...input, line: 2, endLine: 3});
    assert.equal(result.kind, 'text'); assert.equal(result.name, '测试 文档.md'); assert.equal(result.text, '第一行\n第二行\n<script>not executed</script>');
    assert.equal(result.line, 2); assert.equal(result.endLine, 3); assert.equal(result.startLine, 1); assert.equal(result.totalLines, 3); assert.equal(result.truncated, false);
  }
});

test('absolute and normalized parent paths can preview files outside the conversation directory', async t => {
  const {service, root, outside} = await fixture(t); const secret = path.join(outside, 'secret.txt'); await fs.writeFile(secret, 'outside');
  for (const input of [{path: secret}, {threadId: 'unknown', path: secret}, {projectId: 'unknown', path: pathToFileURL(secret).href}, {threadId: 'thread', path: '../outside/secret.txt'}, {projectId: 'project', path: '../outside/./secret.txt'}]) assert.equal((await service.preview(input)).text, 'outside');
  assert.equal((await service.resolve({threadId: 'thread', path: '../outside/secret.txt'})).filename, path.resolve(root, '../outside/secret.txt'));
});

test('relative paths need a known base; injected cwd, remote URLs, ADS and device paths fail closed', async t => {
  const {service, root} = await fixture(t);
  for (const input of [{path: 'secret.txt'}, {cwd: root, path: 'secret.txt'}, {threadId: 'unknown', path: 'secret.txt'}, {projectId: 'project', threadId: 'thread', path: 'secret.txt'}, {threadId: 'thread', path: 'file.txt', line: 0}, {threadId: 'thread', path: 'file.txt', line: 5, endLine: 3}]) await assert.rejects(service.preview(input), error => [400, 403].includes(error.status));
  for (const source of ['https://example.invalid/x.txt', 'x.txt:secret', 'x\0.txt', '\\\\?\\C:\\secret.txt', '\\\\.\\NUL']) await assert.rejects(service.preview({threadId: 'thread', path: source}), error => [400, 403].includes(error.status));
  if (process.platform === 'win32') for (const source of ['NUL', 'sub/CON.txt', 'file.txt.', 'x.txt ']) await assert.rejects(service.preview({threadId: 'thread', path: source}), error => error.code === 'FILE_PREVIEW_PATH_INVALID');
  service.bindThread({id: 'relative', cwd: 'relative/path'});
  await assert.rejects(service.preview({threadId: 'relative', path: 'x.txt'}), error => error.code === 'FILE_PREVIEW_SCOPE_UNKNOWN');
});

test('network UNC paths and network working directories are rejected before any filesystem lookup', async t => {
  const service = new FilePreviewService(); service.bindThread({id: 'network', cwd: String.raw`\\server.invalid\share\project`});
  let touched = false;
  for (const name of ['lstat', 'realpath', 'open']) t.mock.method(fs, name, () => {touched = true; throw new Error('network path must never reach filesystem');});
  for (const source of [String.raw`\\server.invalid\share\file.txt`, '//server.invalid/share/file.txt', String.raw`\/server.invalid\share\file.txt`, 'file://server.invalid/share/file.txt', String.raw`\\wsl.localhost\Ubuntu\home\file.txt`]) await assert.rejects(service.preview({path: source}), error => ['FILE_PREVIEW_NETWORK_REFUSED', 'FILE_PREVIEW_PATH_INVALID'].includes(error.code));
  await assert.rejects(service.preview({threadId: 'network', path: 'file.txt'}), error => error.code === 'FILE_PREVIEW_NETWORK_REFUSED');
  assert.equal(touched, false); await service.close();
});

test('selected WSL accepts paths across directories and dot segments but never another distribution', async t => {
  const service = new FilePreviewService({wslDistribution: 'Ubuntu'}); service.bindThread({id: 'wsl', cwd: '/home/lee/project'});
  assert.equal((await service.resolve({threadId: 'wsl', path: '../outside.txt'})).filename, String.raw`\\wsl.localhost\Ubuntu\home\lee\outside.txt`);
  assert.equal((await service.resolve({path: '/etc/example.txt'})).filename, String.raw`\\wsl.localhost\Ubuntu\etc\example.txt`);
  assert.equal((await service.resolve({path: String.raw`\\WSL$\Ubuntu\home\lee\..\example.txt`})).filename, String.raw`\\wsl.localhost\Ubuntu\home\example.txt`);
  if (process.platform === 'win32') {const result = await service.resolve({path: 'C:\\outside\\file.txt'}); assert.equal(result.filename, 'C:\\outside\\file.txt'); assert.equal(result.selectedWsl, false);}
  let touched = false; for (const name of ['lstat', 'realpath', 'open']) t.mock.method(fs, name, () => {touched = true; throw new Error('must reject before filesystem');});
  for (const source of [String.raw`\\wsl.localhost\Debian\file.txt`, String.raw`\\server.invalid\share\file.txt`, '//wsl.localhost/Debian/file.txt']) await assert.rejects(service.preview({threadId: 'wsl', path: source}), error => error.code === 'FILE_PREVIEW_NETWORK_REFUSED');
  assert.equal(touched, false); await service.close();
});

test('UTF-16 and empty text are readable; other encodings and binary files offer an exact download', async t => {
  const {service, root} = await fixture(t);
  await fs.writeFile(path.join(root, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文\nnext', 'utf16le')]));
  assert.equal((await service.preview({threadId: 'thread', path: 'utf16.txt'})).text, '中文\nnext');
  await fs.writeFile(path.join(root, 'empty.txt'), ''); assert.equal((await service.preview({threadId: 'thread', path: 'empty.txt'})).text, '');
  for (const [name, bytes] of [['binary.bin', Buffer.from([0, 1, 2])], ['invalid.txt', Buffer.from([0xff, 0xee])]]) {
    await fs.writeFile(path.join(root, name), bytes);
    assert.equal((await service.preview({threadId: 'thread', path: name})).kind, 'download');
    assert.deepEqual((await service.download({threadId: 'thread', path: name})).bytes, bytes);
  }
});

test('images use verified formats and dimensions; HTML masquerading as PNG is refused', async t => {
  const {service, root} = await fixture(t); await fs.writeFile(path.join(root, 'image.png'), png);
  const result = await service.preview({threadId: 'thread', path: 'image.png'});
  assert.equal(result.kind, 'image'); assert.equal(result.mime, 'image/png'); assert.equal(result.width, 1); assert.deepEqual(Buffer.from(result.base64, 'base64'), png);
  await fs.writeFile(path.join(root, 'fake.png'), '<html>bad</html>');
  await assert.rejects(service.preview({threadId: 'thread', path: 'fake.png'}), error => error.status === 415);
});

test('large text is bounded and large line counts select a bounded window around the referenced line', async t => {
  const {service, root} = await fixture(t); const lines = Array.from({length: 7000}, (_, i) => 'line ' + (i + 1));
  await fs.writeFile(path.join(root, 'many.txt'), lines.join('\n'));
  const result = await service.preview({threadId: 'thread', path: 'many.txt', line: 3500, endLine: 3502});
  assert.equal(result.text.split('\n').length, FILE_PREVIEW_LIMITS.lines); assert.equal(result.startLine, 3000); assert.equal(result.totalLines, 7000); assert.equal(result.truncated, true); assert.ok(result.text.includes('line 3500\n'));
  const last = await service.preview({threadId: 'thread', path: 'many.txt', line: 99999}); assert.equal(last.line, 7000); assert.equal(last.startLine, 5001); assert.ok(last.text.endsWith('line 7000'));
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(FILE_PREVIEW_LIMITS.bytes + 1, 65));
  assert.equal((await service.preview({threadId: 'thread', path: 'large.txt'})).kind, 'download');
  await fs.truncate(path.join(root, 'large.txt'), FILE_DOWNLOAD_LIMIT + 1);
  for (const method of ['preview','download']) await assert.rejects(service[method]({threadId:'thread',path:'large.txt'}), {code:'FILE_PREVIEW_SIZE_LIMIT'});
});

test('project directories list navigable children while missing files and external roots are refused', async t => {
  const {service, root} = await fixture(t); await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(root,'文档 (1).pdf'), '%PDF');
  const listing = await service.preview({threadId:'thread',path:root});
  assert.deepEqual(listing.entries.map(e=>[e.name,e.kind]), [['folder','directory'],['文档 (1).pdf','file']]);
  assert.deepEqual((await service.preview({projectId:'project',path:listing.entries[0].path})).entries, []);
  assert.equal((await service.preview({projectId:'project',path:listing.entries[1].path})).kind,'download');
  assert.equal((await service.download({projectId:'project',path:listing.entries[1].path})).bytes.toString(),'%PDF');
  await assert.rejects(service.download({threadId:'thread',path:'folder'}), {code:'FILE_PREVIEW_FILE_REFUSED'});
  await assert.rejects(service.preview({threadId:'thread',path:'..'}), {code:'FILE_PREVIEW_OUTSIDE_SCOPE'});
  await assert.rejects(service.preview({path:root}), {code:'FILE_PREVIEW_SCOPE_REQUIRED'});
  await assert.rejects(service.download({threadId:'invented',path:listing.entries[1].path}), {code:'FILE_PREVIEW_SCOPE_UNKNOWN'});
  await assert.rejects(service.download({threadId:'thread',path:'../elsewhere.pdf'}), {code:'FILE_PREVIEW_OUTSIDE_SCOPE'});
  await assert.rejects(service.preview({threadId: 'thread', path: 'missing.txt'}), error => error.code === 'FILE_PREVIEW_NOT_FOUND');
});

test('junction and hard links remain refused even though ordinary outside files are allowed', async t => {
  const {service, root, outside} = await fixture(t); const external = path.join(outside, 'secret.txt'); await fs.writeFile(external, 'outside');
  await fs.symlink(outside, path.join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.preview({threadId: 'thread', path: 'junction/secret.txt'}), error => error.code === 'FILE_PREVIEW_LINK_REFUSED');
  await fs.link(external, path.join(root, 'hard.txt'));
  await assert.rejects(service.preview({threadId: 'thread', path: 'hard.txt'}), error => error.code === 'FILE_PREVIEW_FILE_REFUSED');
});

test('a changed canonical project identity is rejected before any file is opened', async t => {
  const {service, root, outside} = await fixture(t); await fs.writeFile(path.join(root, 'file.txt'), 'inside');
  const realpath = fs.realpath; let opened = false;
  t.mock.method(fs, 'realpath', value => value === root ? Promise.resolve(outside) : realpath(value));
  t.mock.method(fs, 'open', () => {opened = true; throw new Error('must not open');});
  await assert.rejects(service.preview({threadId: 'thread', path: 'file.txt'}), error => error.code === 'FILE_PREVIEW_PATH_CHANGED'); assert.equal(opened, false);
});

test('files modified during read fail rather than returning partial content', async t => {
  const {service, root} = await fixture(t); const file = path.join(root, 'changing.txt'); await fs.writeFile(file, 'before');
  const canonical = await fs.realpath(file), open = fs.open; let mutated = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === canonical) {const read = handle.read.bind(handle); handle.read = async (...values) => {const result = await read(...values); await fs.appendFile(file, 'after'); mutated = true; return result;};}
    return handle;
  });
  await assert.rejects(service.preview({threadId: 'thread', path: 'changing.txt'}), error => error.code === 'FILE_PREVIEW_CHANGED'); assert.equal(mutated, true);
});

test('concurrent reads and shutdown are bounded', async t => {
  const {root} = await fixture(t); await fs.writeFile(path.join(root, 'file.txt'), 'text');
  let release; const gate = new Promise(resolve => {release = resolve;});
  const service = new FilePreviewService({projects: {list: async () => {await gate; return {projects: [{id: 'project', path: root}]};}}});
  const pending = Array.from({length: FILE_PREVIEW_LIMITS.concurrent}, () => service.preview({projectId: 'project', path: 'file.txt'}));
  await assert.rejects(service.preview({projectId: 'project', path: 'file.txt'}), error => error.code === 'FILE_PREVIEW_BUSY');
  const closed = service.close(); release(); await Promise.all(pending); await closed;
  await assert.rejects(service.preview({projectId: 'project', path: 'file.txt'}), error => error.code === 'FILE_PREVIEW_CLOSED');
});
