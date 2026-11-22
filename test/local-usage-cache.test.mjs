import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {gzipSync} from 'node:zlib';
import {scanLocalCodexUsage} from '../src/local-usage-scan.mjs';

const exec = promisify(execFile);
const scanModule = new URL('../src/local-usage-scan.mjs', import.meta.url).href;
const child = `import {scanLocalCodexUsage} from ${JSON.stringify(scanModule)};
  const result = await scanLocalCodexUsage(process.argv[1], {cacheRoot:process.argv[2]});
  process.stdout.write(JSON.stringify(result));`;
async function restart(root, cacheRoot) {
  const {stdout} = await exec(process.execPath, ['--input-type=module','-e',child,root,cacheRoot], {windowsHide:true});
  return JSON.parse(stdout);
}
const privateText = 'private conversation content';
const meta = JSON.stringify({type:'session_meta',payload:{id:'11111111-1111-4111-8111-111111111111'}});
const count = value => JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:value}}}});
const log = total => [meta, JSON.stringify({type:'response_item',payload:{text:privateText}}), count(1), count(total)].join('\n');
async function setup(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'codecang-usage-index-'));
  t.after(() => fs.rm(parent, {recursive:true,force:true}));
  const root = path.join(parent, 'sessions'), cacheRoot = path.join(parent, 'statistics');
  await fs.mkdir(root);
  return {parent,root,cacheRoot};
}

test('new processes reuse projections and only reread changed files, including compressed files and incomplete tails', async t => {
  const {root,cacheRoot} = await setup(t);
  const plain = path.join(root, 'plain.jsonl'), packed = path.join(root, 'packed.jsonl.gz');
  const partialLine = count(23).slice(0,-3);
  const original = log(8) + '\n' + partialLine;
  const gzip = gzipSync(log(44));
  await fs.writeFile(plain, original);
  await fs.writeFile(packed, gzip);
  const cold = await restart(root, cacheRoot);
  assert.equal(cold.diskBytesRead, Buffer.byteLength(original) + gzip.length);
  const reopened = await restart(root, cacheRoot);
  assert.equal(reopened.cacheHits, 2);
  assert.equal(reopened.diskBytesRead, 0);
  assert.deepEqual(reopened.sessions, cold.sessions);
  assert.equal(cold.sessions.find(s => s.sourceId === 'plain.jsonl').diagnosticCounts['incomplete-tail'], 1);

  await fs.appendFile(plain, count(23).slice(-3));
  const appended = await restart(root, cacheRoot);
  assert.equal(appended.cacheHits, 1);
  assert.equal(appended.diskBytesRead, Buffer.byteLength(original) + 3);
  const complete = appended.sessions.find(s => s.sourceId === 'plain.jsonl');
  assert.equal(complete.snapshot.totalTokens, 23);
  assert.deepEqual(complete.increments.map(i => i.tokens.totalTokens), [7,15]);
  t.diagnostic(`source body diskBytesRead: cold=${cold.diskBytesRead}, reopened=${reopened.diskBytesRead}, appended=${appended.diskBytesRead}`);

  // A rewrite of earlier records followed by growth is indistinguishable from an append by size alone.
  await fs.writeFile(plain, log(2) + '\n' + count(23) + '\n' + count(37));
  assert.deepEqual((await restart(root, cacheRoot)).sessions.find(s => s.sourceId === 'plain.jsonl').increments.map(i => i.tokens.totalTokens), [1,21,14]);
  await fs.appendFile(plain, '\n' + meta);
  assert.deepEqual((await restart(root, cacheRoot)).sessions.find(s => s.sourceId === 'plain.jsonl').increments, []);
  await fs.unlink(plain);
  const replacement = gzipSync(log(50));
  await fs.writeFile(packed, replacement);
  const afterDelete = await restart(root, cacheRoot);
  assert.equal(afterDelete.diskBytesRead, replacement.length);
  assert.deepEqual(afterDelete.sessions.map(s => [s.sourceId,s.snapshot.totalTokens]), [['packed.jsonl.gz',50]]);
  const stored = await fs.readFile(path.join(cacheRoot,'local-usage-index.cache'),'utf8');
  assert.ok(!stored.includes(privateText) && !stored.includes(root) && !stored.includes('plain.jsonl'));
});

test('roots sharing one profile keep separate projections, even for the same relative path', async t => {
  const {parent,root,cacheRoot} = await setup(t);
  const other = path.join(parent,'archived');
  await fs.mkdir(other);
  await fs.writeFile(path.join(root,'same.jsonl'),log(3));
  await fs.writeFile(path.join(other,'same.jsonl'),log(4));
  await restart(root,cacheRoot);
  const b = await restart(other,cacheRoot);
  assert.equal(b.cacheHits,0);
  assert.equal(b.sessions[0].snapshot.totalTokens,4);
  const a = await restart(root,cacheRoot);
  assert.equal(a.cacheHits,1);
  assert.equal(a.sessions[0].snapshot.totalTokens,3);
});

test('damaged indexes are rebuilt; an unusable cache or linked destination does not block the scan', async t => {
  const {parent,root,cacheRoot} = await setup(t);
  const logFile = path.join(root,'one.jsonl'), indexFile = path.join(cacheRoot,'local-usage-index.cache');
  await fs.writeFile(logFile,log(7));
  await scanLocalCodexUsage(root,{cacheRoot});
  await fs.writeFile(indexFile,'damaged');
  const recovered = await scanLocalCodexUsage(root,{cacheRoot});
  assert.equal(recovered.diagnosticCounts['usage-index-invalid'],1);
  assert.equal(recovered.partial,false);
  assert.equal(recovered.diskBytesRead,Buffer.byteLength(log(7)));
  assert.equal((await restart(root,cacheRoot)).diskBytesRead,0);
  const other = path.join(parent,'untouched');
  await fs.unlink(indexFile);
  await fs.writeFile(other,'untouched');
  await fs.link(other,indexFile);
  const unsafe = await scanLocalCodexUsage(root,{cacheRoot});
  assert.equal(unsafe.diagnosticCounts['usage-index-unsafe'],1);
  assert.equal(unsafe.sessions[0].snapshot.totalTokens,7);
  assert.equal(await fs.readFile(other,'utf8'),'untouched');
  const denied = await scanLocalCodexUsage(root,{cacheRoot:logFile});
  assert.equal(denied.diagnosticCounts['usage-index-unsafe'],1);
  assert.equal(denied.sessions[0].snapshot.totalTokens,7);
});

test('a linked cache directory cannot redirect reads or writes', async t => {
  const {parent,root,cacheRoot} = await setup(t);
  const outside = path.join(parent,'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside,cacheRoot,process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root,'one.jsonl'),log(6));
  const result = await scanLocalCodexUsage(root,{cacheRoot});
  assert.equal(result.diagnosticCounts['usage-index-unsafe'],1);
  assert.equal(result.sessions[0].snapshot.totalTokens,6);
  assert.deepEqual(await fs.readdir(outside),[]);
});

test('a failed index publish leaves the earlier snapshot intact and file identity still detects a same-size rewrite', async t => {
  const {root,cacheRoot} = await setup(t);
  const file = path.join(root,'one.jsonl');
  const fixedTime = new Date('2024-01-01T00:00:00Z');
  await fs.writeFile(file,log(9));
  await fs.utimes(file,fixedTime,fixedTime);
  await restart(root,cacheRoot);
  await fs.writeFile(file,log(5));
  await fs.utimes(file,fixedTime,fixedTime);
  const rename = t.mock.method(fs,'rename',async () => { throw Object.assign(new Error('storage unavailable'),{code:'ENOSPC'}); });
  const result = await scanLocalCodexUsage(root,{cacheRoot});
  assert.equal(result.cacheHits,0);
  assert.equal(result.diagnosticCounts['usage-index-write-failed'],1);
  assert.equal(result.sessions[0].snapshot.totalTokens,5);
  assert.deepEqual(await fs.readdir(cacheRoot),['local-usage-index.cache']);
  rename.mock.restore();
  const repaired = await restart(root,cacheRoot);
  assert.equal(repaired.cacheHits,0);
  assert.equal(repaired.sessions[0].snapshot.totalTokens,5);
  assert.equal((await restart(root,cacheRoot)).cacheHits,1);
});
