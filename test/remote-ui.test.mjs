import test from 'node:test';import assert from 'node:assert/strict';import {remoteStatusLabel,pairingExpiry,safePairing,pairingQuery,remoteActionState,remoteEnvironmentChanged,canRevokeDevice} from '../public/remote.js';import {makeMutation,serializeMarkers} from '../public/submissions.js';
test('connected remote is not presented as verified mobile success',()=>{assert.match(remoteStatusLabel('connected'),/未验证/);assert.match(remoteStatusLabel('new'),/未知/);});
test('pairing expiration requires known valid future instant',()=>{assert.equal(pairingExpiry(1800000000),1800000000000);assert.ok(Number.isNaN(pairingExpiry('2027-01-01T00:00:00Z')));assert.ok(Number.isNaN(pairingExpiry(1800000000.5)));assert.ok(Number.isNaN(pairingExpiry(Number.MAX_SAFE_INTEGER)));assert.ok(Number.isNaN(pairingExpiry(-1)));assert.equal(safePairing({pairingCode:'secret',expiresAt:'invalid'},1000),null);assert.equal(safePairing({pairingCode:'secret',expiresAt:1},2000),null);});
test('pairing queries include exactly one code and cease on expiration',()=>{const pair=safePairing({pairingCode:'secret',manualPairingCode:'manual',expiresAt:1800000000},1000);assert.deepEqual(pairingQuery(pair,1000),{pairingCode:'secret'});assert.equal(pairingQuery(pair,1800000000000),null);assert.deepEqual(pairingQuery({...pair,pairingCode:null},1000),{manualPairingCode:'manual'});});
test('remote mutation carries explicit wrapper confirmation but durable marker never stores data',()=>{const op=makeMutation('a'.repeat(32),'remoteControl/pairing/start',{manualCode:true},{confirmed:true,now:1000,uuid:'00000000-0000-4000-8000-000000000001'});assert.equal(op.envelope.confirmed,true);assert.ok(!serializeMarkers([op.marker]).includes('manualCode'));});
test('remote actions follow connection and reported state; read-only refresh survives',()=>{
 const disconnected=remoteActionState({connected:false,status:{status:'connected',environmentId:'env'}});
 assert.equal(disconnected.refresh,false);for(const key of ['enable','disable','pair','pairCheck','revoke'])assert.equal(disconnected[key],false,key);
 const unknown=remoteActionState({connected:true,status:null});
 assert.equal(unknown.refresh,true);for(const key of ['enable','disable','pair','pairCheck','revoke'])assert.equal(unknown[key],false,key);
 const disabled=remoteActionState({connected:true,status:{status:'disabled',environmentId:'env'}});
 assert.equal(disabled.refresh,true);assert.equal(disabled.enable,true);assert.equal(disabled.disable,false);assert.equal(disabled.pair,false);assert.equal(disabled.revoke,false);
 const ready=remoteActionState({connected:true,status:{status:'connected',environmentId:'env'}});
 assert.equal(ready.disable,true);assert.equal(ready.pair,true);assert.equal(ready.revoke,true);assert.equal(ready.pairCheck,false);
 const active=remoteActionState({connected:true,status:{status:'connected',environmentId:'env'},pair:safePairing({pairingCode:'secret',expiresAt:1800000000},1000),now:1000});
 assert.equal(active.pairCheck,true);
 const expired=remoteActionState({connected:true,status:{status:'connected',environmentId:'env'},pair:safePairing({pairingCode:'secret',expiresAt:1800000000},1000),now:1800000000000});
 assert.equal(expired.pairCheck,false);
 const locked=remoteActionState({connected:true,pending:true,status:{status:'connected',environmentId:'env'},pair:safePairing({pairingCode:'secret',expiresAt:1800000000},1000),now:1000});
 assert.equal(locked.refresh,true);for(const key of ['enable','disable','pair','pairCheck','revoke'])assert.equal(locked[key],false,key);
});
test('environment changes clear old context and never authorize an old-environment revoke',()=>{
 assert.equal(remoteEnvironmentChanged({environmentId:'old'},{environmentId:'new'}),true);
 assert.equal(remoteEnvironmentChanged({environmentId:'same'},{environmentId:'same'}),false);
 assert.equal(remoteEnvironmentChanged(null,{environmentId:'new'}),true);
 assert.equal(canRevokeDevice({status:'connected',environmentId:'old'},'new'),false);
 assert.equal(canRevokeDevice({status:'disabled',environmentId:'new'},'new'),false);
 assert.equal(canRevokeDevice({status:'connected',environmentId:'new'},'new'),true);
});
