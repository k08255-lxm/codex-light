import test from 'node:test';
import assert from 'node:assert/strict';
import { absolutePath } from '../public/delegated-changes.js';
import { fileSummary } from '../public/state.js';

const cwd = '//wsl.localhost/Ubuntu/home/lee/Repo';
const diff = file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-before\n+after\n`;
const item = file => ({ type: 'fileChange', status: 'completed', changes: [{ path: cwd + '/' + file, kind: { type: 'update' }, diff: diff(file) }] });

test('WSL file keys preserve Linux case and normalize host share aliases', () => {
  assert.notEqual(absolutePath(cwd + '/Foo.js', cwd), absolutePath(cwd + '/foo.js', cwd));
  assert.equal(absolutePath('Foo.js', cwd), absolutePath('\\\\WSL$\\Ubuntu\\home\\lee\\Repo\\Foo.js', cwd));
  assert.equal(absolutePath('C:\\Repo\\Foo.js', ''), absolutePath('c:/repo/foo.js', ''));
});

test('WSL unified turn diff matches the original absolute file and keeps its preview', () => {
  const result = fileSummary([item('Foo.js')], diff('Foo.js'), { cwd });
  assert.equal(result.count, 1, 'one edit must not create a second unchanged file');
  assert.equal(result.rows[0].fullPath, cwd + '/Foo.js');
  assert.equal(result.rows[0].diffs[0].trimEnd(), diff('Foo.js').trimEnd());
  assert.equal(result.added, 1); assert.equal(result.removed, 1);
});

test('case-distinct WSL files retain independent edits and diff previews', () => {
  const result = fileSummary([item('Foo.js'), item('foo.js')], diff('Foo.js') + diff('foo.js'), { cwd });
  assert.equal(result.count, 2);
  assert.deepEqual(new Set(result.rows.map(row => row.fullPath)), new Set([cwd + '/Foo.js', cwd + '/foo.js']));
  assert.ok(result.rows.every(row => row.diffs.length === 1));
});

test('Linux absolute diff headers and WSL share items identify the same file', () => {
  const nativeDiff = diff('/home/lee/Repo/Foo.js');
  const result = fileSummary([item('Foo.js')], nativeDiff, { cwd });
  assert.equal(result.count, 1);
  assert.equal(result.rows[0].fullPath, cwd + '/Foo.js');
  assert.equal(result.rows[0].diffs[0].trimEnd(), nativeDiff.trimEnd());
  assert.equal(absolutePath('/home/lee/Repo/Foo.js', cwd), absolutePath('Foo.js', cwd));
  assert.notEqual(absolutePath('/home/lee/Repo/foo.js', cwd), absolutePath('Foo.js', cwd));
});
