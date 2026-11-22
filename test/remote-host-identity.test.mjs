import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {loadRemoteHostId} from '../src/remote-host-identity.mjs';

test('concurrent launches and later updates reuse the published ID while separate installations differ', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codecang-identity-'));
  t.after(()=>rm(root, {recursive:true,force:true}));
  const a = path.join(root,'pc-a'), b = path.join(root,'pc-b');
  const ids = await Promise.all(Array.from({length:12}, ()=>loadRemoteHostId(a)));
  assert.equal(new Set(ids).size, 1);
  assert.match(ids[0], /^[0-9a-f]{32}$/);
  assert.equal(await loadRemoteHostId(a), ids[0]);
  assert.notEqual(await loadRemoteHostId(b), ids[0]);
  assert.deepEqual(await readdir(a), ['host-id']);
  await writeFile(path.join(a,'host-id'), 'damaged');
  await assert.rejects(loadRemoteHostId(a));
  assert.equal(await readFile(path.join(a,'host-id'),'utf8'), 'damaged');
});
