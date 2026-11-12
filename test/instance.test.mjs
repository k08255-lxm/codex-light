import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {acquireInstance,probeInstance} from '../src/instance.mjs';import {createServer} from '../src/server.mjs';
async function folder(t){const directory=await mkdtemp(path.join(os.tmpdir(),'codex-light-lock-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
test('instance lock contains only nonsecret metadata and refuses active duplicate',async t=>{
 const directory=await folder(t);const first=await acquireInstance({directory,probe:async()=>false,isAlive:()=>true});assert.equal(first.active,false);
 await first.publish({pid:1234,port:43210,serverInstance:'opaque-instance'});const raw=await readFile(first.file,'utf8');assert.ok(!/token|authorization|#|http/i.test(raw));
 const duplicate=await acquireInstance({directory,probe:async()=>true,isAlive:()=>true});assert.equal(duplicate.active,true);assert.equal(duplicate.record.port,43210);
 await first.release();
});
test('stale metadata is reclaimed, corrupted metadata is never overwritten',async t=>{
 const directory=await folder(t);const first=await acquireInstance({directory,probe:async()=>false,isAlive:()=>false});
 const second=await acquireInstance({directory,probe:async()=>false,isAlive:()=>false});assert.equal(second.active,false);
 await first.release();assert.ok(await readFile(second.file,'utf8'),'old holder must not delete new holder');
 await writeFile(second.file,'invalid');await assert.rejects(acquireInstance({directory,probe:async()=>false,isAlive:()=>false}),/损坏/);assert.equal(await readFile(second.file,'utf8'),'invalid');
});
test('probe verifies a live loopback service without exposing its authorization token',async t=>{
 const app=await createServer({demo:true});await app.started;t.after(()=>app.close());
 const record={pid:process.pid,port:app.server.address().port,serverInstance:app.operations.serverInstance};assert.equal(await probeInstance(record),true);assert.equal(await probeInstance({...record,serverInstance:'wrong'}),false);
 const health=await(await fetch(app.origin+'/health')).json();assert.equal(health.app,'codex-light');assert.equal(health.token,undefined);
});
