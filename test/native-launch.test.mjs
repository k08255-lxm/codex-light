import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {launchNative, resolveNativeExecutable} from '../src/native-launch.mjs';

async function fixture(t, {payload = true} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-launch-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const dist = path.join(root, 'desktop', 'dist');
  const directory = 'CodexLight-win-x64-20261112-test';
  const build = path.join(dist, directory);
  const manifest = path.join(dist, 'current.json');
  await mkdir(build, {recursive: true});
  if (payload) {
    await mkdir(path.join(build, 'app', 'src'), {recursive: true});
    await writeFile(path.join(build, 'CodexLight.exe'), 'test fixture; never execute');
    await writeFile(path.join(build, 'app', 'src', 'desktop-backend.mjs'), '// test fixture');
  }
  return {root, dist, directory, build, manifest};
}

test('missing manifest clearly refuses launch without scanning an available build', async t => {
  const {root} = await fixture(t);
  await assert.rejects(resolveNativeExecutable(root), /尚未生成桌面构建.*没有启动后台/);
});

test('valid bounded manifest resolves exact executable with backend payload', async t => {
  const {root, directory, build, manifest} = await fixture(t);
  await writeFile(manifest, JSON.stringify({directory}));
  assert.equal(await resolveNativeExecutable(root), await realpath(path.join(build, 'CodexLight.exe')));
});

test('manifest rejects traversal, absolute paths, extra fields, bad JSON and excess bytes', async t => {
  const {root, directory, manifest} = await fixture(t);
  for (const value of [
    {directory: '../CodexLight-win-x64-escape'},
    {directory: 'CodexLight-win-x64-test/../../outside'},
    {directory: 'CodexLight-win-x64-..'},
    {directory: path.resolve(root)},
    {directory: 'C:\\outside'},
    {directory, extra: true},
    {directory: 1},
    [directory], null
  ]) {
    await writeFile(manifest, JSON.stringify(value));
    await assert.rejects(resolveNativeExecutable(root), /桌面构建不完整或路径不安全.*没有启动后台/);
  }
  for (const contents of ['{bad', 'x'.repeat(4097)]) {
    await writeFile(manifest, contents);
    await assert.rejects(resolveNativeExecutable(root), /桌面构建不完整或路径不安全/);
  }
});

test('manifest cannot select missing executable or backend payload', async t => {
  const {root, directory, build, manifest} = await fixture(t, {payload: false});
  await writeFile(manifest, JSON.stringify({directory}));
  await assert.rejects(resolveNativeExecutable(root), /桌面构建不完整/);
  await writeFile(path.join(build, 'CodexLight.exe'), 'test fixture; never execute');
  await assert.rejects(resolveNativeExecutable(root), /桌面构建不完整/);
  await mkdir(path.join(build, 'app', 'src', 'desktop-backend.mjs'), {recursive: true});
  await assert.rejects(resolveNativeExecutable(root), /桌面构建不完整/);
});

test('directory link cannot redirect a manifest build outside dist', async t => {
  const {root, directory, build, manifest} = await fixture(t);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await rm(build, {recursive: true});
  try { await symlink(outside, build, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip(`当前环境不能创建目录链接（${error.code}）`);
    throw error;
  }
  await writeFile(manifest, JSON.stringify({directory}));
  await assert.rejects(resolveNativeExecutable(root), /桌面构建不完整或路径不安全/);
});

test('native launch passes demo to visible independent GUI using mocked spawn only', async t => {
  const {root, directory, build, manifest} = await fixture(t);
  await writeFile(manifest, JSON.stringify({directory}));
  let call, unref = false;
  const child = new EventEmitter();
  child.unref = () => { unref = true; };
  const result = await launchNative({root, args: ['--demo'], spawnProcess: (...args) => {
    call = args;
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }});
  assert.equal(result, child);
  assert.equal(unref, true);
  assert.deepEqual(call, [await realpath(path.join(build, 'CodexLight.exe')), ['--demo'], {cwd: await realpath(build), detached: true, windowsHide: false, stdio: 'ignore', shell: false}]);
});

test('unknown and legacy codex arguments fail before any spawn or background startup', async () => {
  let spawned = false;
  const spawnProcess = () => { spawned = true; throw new Error('must not spawn'); };
  for (const args of [['--codex', 'custom.exe'], ['--codex=custom.exe']]) {
    await assert.rejects(launchNative({root: 'nonexistent', args, spawnProcess}), /CODEX_LIGHT_CODEX.*--browser/);
  }
  await assert.rejects(launchNative({root: 'nonexistent', args: ['--unknown'], spawnProcess}), /仅支持 --demo/);
  assert.equal(spawned, false);
});

test('spawn errors are observable and do not unref a nonexistent GUI', async t => {
  const {root, directory, manifest} = await fixture(t);
  await writeFile(manifest, JSON.stringify({directory}));
  const child = new EventEmitter();
  let unref = false;
  child.unref = () => { unref = true; };
  await assert.rejects(launchNative({root, spawnProcess: () => {
    queueMicrotask(() => child.emit('error', new Error('fixture spawn failure')));
    return child;
  }}), /fixture spawn failure/);
  assert.equal(unref, false);
});

test('Windows defaults route before instance acquisition and browser entry is explicit', async () => {
  const source = await readFile(new URL('../src/launch.mjs', import.meta.url), 'utf8');
  assert.match(source, /if\(process\.platform==='win32'&&!browserMode\)/);
  assert.ok(source.indexOf('await launchNative({args})') < source.indexOf('await acquireInstance('));
  assert.match(source, /filter\(argument=>argument!=='--browser'\)/);
  assert.match(source, /浏览器开发模式.*后台服务独立运行/);
  const {scripts} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts.browser, 'node src/launch.mjs --browser');
  assert.equal(scripts.demo, 'node src/launch.mjs --demo');
});
