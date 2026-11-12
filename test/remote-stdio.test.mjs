import test from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {RpcClient} from '../src/rpc.mjs';import {createServer} from '../src/server.mjs';
test('HTTP remote confirmation, pairing, observed-client binding via real synthetic stdio process',async t=>{
 const rpc=new RpcClient({command:process.execPath,args:[fileURLToPath(new URL('./remote-stdio-peer.mjs',import.meta.url))]});
 const app=await createServer({client:rpc});t.after(()=>app.close());await app.started;let n=0;
 const call=async(method,params={},confirmed)=>{const r=await fetch(app.origin+'/api/rpc',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({method,params,confirmed,requestId:app.operations.serverInstance+':'+Date.now()+':remote-test-'+(++n)})});return{status:r.status,value:await r.json()};};
 assert.equal((await call('remoteControl/enable',{ephemeral:true})).status,400);
 assert.equal((await call('remoteControl/status/read')).value.status,'disabled');
 assert.equal((await call('remoteControl/enable',{ephemeral:true},true)).value.status,'connected');
 assert.equal((await call('remoteControl/client/revoke',{environmentId:'mock-env',clientId:'mock-client'},true)).status,400);
 const pair=await call('remoteControl/pairing/start',{manualCode:true},true);assert.equal(pair.status,200);assert.equal(pair.value.manualPairingCode,'SYNTHETIC');
 assert.equal((await call('remoteControl/pairing/status',{pairingCode:'not-owned'})).status,400);
 assert.equal((await call('remoteControl/pairing/status',{pairingCode:pair.value.pairingCode})).value.claimed,true);
 assert.equal((await call('remoteControl/pairing/status',{pairingCode:pair.value.pairingCode})).status,400);
 const clients=await call('remoteControl/client/list',{environmentId:'mock-env',limit:100,order:'desc'});assert.equal(clients.value.data[0].clientId,'mock-client');
 assert.equal((await call('remoteControl/client/revoke',{environmentId:'mock-env',clientId:'mock-client'},true)).status,200);
 assert.equal((await call('remoteControl/disable',{ephemeral:false},true)).value.status,'disabled');
});
