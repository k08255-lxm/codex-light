import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {IgnoredQuestions} from '../src/ignored-questions.mjs';

test('question ignores survive host restart and are scoped to runtime, thread and item', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'codecang-questions-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new IgnoredQuestions(root,'native');
  await store.load();
  await Promise.all([store.ignore('thread','first'),store.ignore('thread','first')]);
  const reopened=new IgnoredQuestions(root,'native'), otherRuntime=new IgnoredQuestions(root,'wsl');
  await Promise.all([reopened.load(),otherRuntime.load()]);
  assert.equal(reopened.has('thread','first'),true);
  assert.equal(reopened.has('thread','second'),false);
  assert.equal(reopened.has('other','first'),false);
  assert.equal(otherRuntime.has('thread','first'),false);
  await assert.rejects(store.ignore('thread','../invalid'),{status:400});
  const folder=path.join(root,'ignored-questions'), markers=await readdir(folder);
  assert.equal(markers.length,1); assert.match(markers[0],/^[a-f0-9]{64}$/);
  assert.equal((await readFile(path.join(folder,markers[0]))).length,0);
});
