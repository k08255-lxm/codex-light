import test from 'node:test';import assert from 'node:assert/strict';import {lstat} from 'node:fs/promises';
import {createReopener,requestReopen,validateReopenPayload} from '../src/reopen.mjs';
const url='http://127.0.0.1:12345/#token='+'a'.repeat(64),serverInstance='instance';
test('reopen validates exact origin, token syntax and instance',()=>{
 assert.equal(validateReopenPayload({url,serverInstance},{port:12345,serverInstance}),url);
 for(const bad of ['https://example.com/','http://localhost:12345/#token='+'a'.repeat(64),'http://127.0.0.1:12345/?x=y#token='+'a'.repeat(64)])assert.throws(()=>validateReopenPayload({url:bad}));
 assert.throws(()=>validateReopenPayload({url,serverInstance},{port:12346}));assert.throws(()=>validateReopenPayload({url,serverInstance},{serverInstance:'other'}));
});
test('private Unix socket reopens same instance and closes cleanly',{skip:process.platform==='win32'},async t=>{
 let service;try{service=await createReopener({url,serverInstance});}catch(error){if(error.code==='EPERM'){t.skip('Environment denies Unix socket listen; requires host validation');return;}throw error;}try{
 assert.equal((await lstat(service.endpoint)).mode&0o777,0o600);
 assert.equal(await requestReopen({reopenEndpoint:service.endpoint,port:12345,serverInstance}),url);
 await assert.rejects(requestReopen({reopenEndpoint:service.endpoint,port:12345,serverInstance:'other'}));
 }finally{const close=service.close();assert.equal(service.close(),close);await close;}
 await assert.rejects(lstat(service.endpoint));
});
test('Windows helper source enforces explicit protected SID ACL without execution-policy bypass',async()=>{
 const {readFile}=await import('node:fs/promises');
 const helper=await readFile(new URL('../src/reopen-helper.ps1',import.meta.url),'utf8');const module=await readFile(new URL('../src/reopen.mjs',import.meta.url),'utf8');
 for(const fragment of ['SetAccessRuleProtection($true, $false)','SetOwner($sid)','$pipe.GetAccessControl()','$rules.Count -ne 1','IdentityReference.Value -ne $sid.Value'])assert.ok(helper.includes(fragment));
 assert.ok(!module.includes('-ExecutionPolicy'));assert.ok(module.includes('JSON.stringify({name,payload,parentPid:process.pid})'));
});
test('Windows reopening client verifies kernel pipe ACL before reading and disables impersonation',async()=>{
 const {readFile}=await import('node:fs/promises');const helper=await readFile(new URL('../src/reopen-helper.ps1',import.meta.url),'utf8');
 const client=helper.slice(helper.indexOf("if ($config.mode -eq 'client')"),helper.indexOf('  $acl ='));
 assert.ok(client.includes('PipeAccessRights]::ReadPermissions'));assert.ok(client.includes('TokenImpersonationLevel]::Anonymous'));
 assert.ok(client.indexOf('Assert-PrivatePipe $pipe $sid')<client.indexOf('$pipe.ReadAsync'));
 assert.ok(helper.includes('$readAck'));assert.ok(client.includes('$pipe.WriteByte(1)'));
});
