import test from 'node:test';import assert from 'node:assert/strict';
import {validateRemote,REMOTE_METHODS,MUTATING_REMOTE_METHODS} from '../src/remote.mjs';
const prefix='remoteControl/';
test('remote allowlist and plain fields reject unknown input',()=>{
 assert.equal(REMOTE_METHODS.size,7);assert.equal(MUTATING_REMOTE_METHODS.size,4);
 for(const params of [null,[],new Date(),{unexpected:true}])assert.throws(()=>validateRemote(prefix+'status/read',params));
 assert.throws(()=>validateRemote('remoteControl/anything',{}));
 assert.deepEqual(validateRemote(prefix+'status/read',{}),{});
});
test('all remote mutations require literal confirmation; ephemeral defaults do not mutate input',()=>{
 for(const method of MUTATING_REMOTE_METHODS)for(const confirmed of [undefined,false,'true',1])assert.throws(()=>validateRemote(method,{}, {confirmed}),{code:'REMOTE_CONFIRMATION_REQUIRED'});
 for(const method of ['enable','disable']){
  const params={};assert.deepEqual(validateRemote(prefix+method,params,{confirmed:true}),{ephemeral:true});assert.deepEqual(params,{});
  assert.deepEqual(validateRemote(prefix+method,{ephemeral:false},{confirmed:true}),{ephemeral:false});
  for(const ephemeral of [null,'false',0])assert.throws(()=>validateRemote(prefix+method,{ephemeral},{confirmed:true}));
 }
 assert.deepEqual(validateRemote(prefix+'pairing/start',{manualCode:true},{confirmed:true}),{manualCode:true});
 assert.throws(()=>validateRemote(prefix+'pairing/start',{ephemeral:true},{confirmed:true}));
});
test('pairing status requires exactly one bounded nonempty code and no mutation confirmation',()=>{
 for(const params of [{},{pairingCode:null},{pairingCode:'a',manualPairingCode:'b'},{pairingCode:''},{pairingCode:'bad\ncode'},{manualPairingCode:'x'.repeat(4097)}])assert.throws(()=>validateRemote(prefix+'pairing/status',params));
 assert.deepEqual(validateRemote(prefix+'pairing/status',{pairingCode:'abc',manualPairingCode:null}),{pairingCode:'abc',manualPairingCode:null});
});
test('client listing validates IDs, optional nullable paging and environment binding',()=>{
 const params={environmentId:'env',cursor:null,limit:20,order:'desc'};assert.deepEqual(validateRemote(prefix+'client/list',params,{activeEnvironmentId:'env'}),params);
 for(const extra of [{environmentId:''},{limit:0},{limit:101},{limit:1.5},{order:'other'},{cursor:4}])assert.throws(()=>validateRemote(prefix+'client/list',{environmentId:'env',...extra},{activeEnvironmentId:'env'}));
 assert.throws(()=>validateRemote(prefix+'client/list',params,{activeEnvironmentId:'other'}));
});
test('revoke only allows confirmed client observed in current environment',()=>{
 const params={environmentId:'env',clientId:'client'};
 assert.throws(()=>validateRemote(prefix+'client/revoke',params,{confirmed:true}),{code:'REMOTE_UNKNOWN_ENVIRONMENT'});
 assert.throws(()=>validateRemote(prefix+'client/revoke',params,{confirmed:true,activeEnvironmentId:'env',allowedClientIds:new Set(['other'])}));
 assert.deepEqual(validateRemote(prefix+'client/revoke',params,{confirmed:true,activeEnvironmentId:'env',allowedClientIds:new Set(['client'])}),params);
});
