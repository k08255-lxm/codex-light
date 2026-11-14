import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {checkBackendHealth} from '../src/backend-health.mjs';
const run=promisify(execFile);
test('actual backend starts isolated with auth and closes without real RPC',async()=>{
 const r=await checkBackendHealth();
 assert.equal(r.ok,true);assert.equal(r.realAccountVerified,false);assert.equal(r.scope,'isolated-demo-backend');
 for(const key of ['authenticatedStatus','unauthenticatedRejected','loopbackOnly','gracefulShutdown'])assert.equal(r[key],true);
 assert.equal(JSON.stringify(r).includes('token'),false);
});
test('standalone health exits cleanly with only public evidence',async()=>{
 const {stdout,stderr}=await run(process.execPath,['src/backend-health.mjs'],{timeout:30000});
 assert.equal(stderr,'');const r=JSON.parse(stdout);assert.equal(r.ok,true);assert.match(r.nodeVersion,/^v\d/);
 assert.equal(r.version,JSON.parse(await readFile('package.json','utf8')).version);
});
test('native branch precedes hooks and UI, no production backend entry',async()=>{
 const program=await readFile('desktop/Program.cs','utf8'),native=await readFile('desktop/BackendHealth.cs','utf8');
 assert.ok(program.indexOf('--backend-health-check')<program.indexOf('Velopack.VelopackApp'));
 assert.ok(program.indexOf('--backend-health-check')<program.indexOf('ApplicationConfiguration.Initialize'));
 assert.ok(native.includes('"backend-health.mjs"'));assert.ok(!native.includes('desktop-backend.mjs'));assert.ok(!native.includes('Kill(true)'));
});
test('native health fails closed on each required proof and version mismatch',async()=>{
 const native=await readFile('desktop/BackendHealth.cs','utf8');
 for(const key of ['ok','authenticatedStatus','unauthenticatedRejected','loopbackOnly','gracefulShutdown'])assert.ok(native.includes(`!r.GetProperty("${key}").GetBoolean()`));
 assert.ok(native.includes('r.GetProperty("version").GetString()!=expectedVersion'));
 assert.ok(native.includes('Assembly.GetName().Version?.ToString(3)'));
 assert.ok(native.includes('WindowStyle=ProcessWindowStyle.Hidden'));
 assert.ok(native.includes('catch{Console.WriteLine'));
});
test('native dependency preflight queries WebView without creating UI',async()=>{
 const native=await readFile('desktop/BackendHealth.cs','utf8');
 assert.ok(native.includes('CoreWebView2Environment.GetAvailableBrowserVersionString()'));
 assert.ok(native.includes('string.IsNullOrWhiteSpace(webViewVersion)||!Version.TryParse'));
 assert.ok(native.includes('webViewVersion,dotnetVersion=Environment.Version.ToString()'));
 assert.ok(!native.includes('CreateAsync('));assert.ok(!native.includes('EnsureCoreWebView2Async('));
});
