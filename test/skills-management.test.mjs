import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, rm} from 'node:fs/promises';
import {DemoClient} from '../src/demo.mjs';
import {createServer} from '../src/server.mjs';

test('skill management writes only a discovered path and reports the engine state', async t => {
  const cwd = os.tmpdir(), skillPath = path.join(cwd, 'project-skill', 'SKILL.md');
  const otherPath = path.join(cwd, 'user-skill', 'SKILL.md');
  const writes = [], lookups = [];
  class SkillClient extends DemoClient {
    async call(method, params) {
      if (method === 'skills/list') {
        lookups.push(params);
        return {data:[{cwd, errors:[], skills:[skillPath, otherPath].map(file => ({name:'same', path:file, enabled:true}))}]};
      }
      if (method === 'skills/config/write') { writes.push(params); return {effectiveEnabled:false}; }
      return super.call(method, params);
    }
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'codecang-skill-state-'));
  const app = await createServer({demo:true, desktop:true, desktopStateRoot:root, client:new SkillClient(), cwd});
  t.after(async () => { await app.close(); await rm(root, {recursive:true, force:true}); });
  const post = (action, input, token=app.token) => fetch(app.origin+'/api/skills/'+action, {
    method:'POST', headers:{Authorization:'Bearer '+token, 'Content-Type':'application/json'}, body:JSON.stringify(input),
  });
  assert.equal((await post('list', {}, 'invalid')).status, 401);
  assert.equal((await post('list', {cwd:'relative'})).ok, false);
  assert.equal((await post('list', {forceReload:'yes'})).ok, false);
  const catalog = await (await post('list', {cwd})).json();
  assert.deepEqual(catalog.data[0].skills.map(s => s.path), [skillPath, otherPath]);
  const operation = suffix => app.operations.serverInstance+':'+Date.now()+':'+suffix;
  const input = {cwd, path:otherPath, enabled:false, requestId:operation('specific-skill')};
  const [first,retry] = await Promise.all([post('set-enabled', input), post('set-enabled', input)]);
  assert.equal(first.status, 200); assert.equal(retry.status, 200);
  assert.deepEqual(await first.json(), {effectiveEnabled:false});
  assert.deepEqual(writes, [{path:otherPath, enabled:false}]);
  assert.deepEqual(lookups.at(-1), {cwds:[cwd], forceReload:true});
  const stale = await post('set-enabled', {...input, requestId:operation('stale-skill'), path:path.join(cwd,'missing.md')});
  assert.equal(stale.status, 409);
  assert.equal(writes.length, 1);
});
