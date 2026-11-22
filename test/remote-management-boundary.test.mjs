import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {DemoClient} from '../src/demo.mjs';
import {createServer} from '../src/server.mjs';
import {REMOTE_METHODS} from '../src/remote.mjs';
import {mountAccount} from '../public/ui/account-view.js';
import {mountAccountLoginPanel} from '../public/account-login-panel.js';
import {createDocument} from './mini-dom.mjs';

test('phone account page keeps read-only quota and lists credits without a redemption or login action', async () => {
  const doc = createDocument(), host = doc.createElement('main'), login = doc.createElement('div');
  const controls = mountAccountLoginPanel(login, {readOnly:true, api:()=>assert.fail('remote login request')});
  await controls.activate();
  assert.equal(login.querySelector('button'), null);
  assert.match(login.textContent,/电脑上操作/);
  const page = mountAccount(host, {readOnly:true, rpc:async method => {
    if (method === 'account/read') return {account:null};
    if (method === 'account/usage/read') return {};
    assert.equal(method,'account/rateLimits/read');
    return {rateLimitResetCredits:{availableCount:1,credits:[{id:'sample',title:'测试卡',status:'available',resetType:'codexRateLimits'}]}};
  }});
  await page.activate();
  assert.match(host.textContent,/测试卡/);
  assert.equal(host.querySelector('.acct-credit-row').querySelector('button'), null);
});

function open(target, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname:'127.0.0.1', port:target.port, path, agent:false,
      method:body === undefined ? 'GET' : 'POST',
      headers:{Host:new URL(target.origin).host, Origin:target.origin,
        Authorization:'Bearer ' + target.token, 'Content-Type':'application/json'}}, resolve);
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function json(target, path, body) {
  const res = await open(target, path, body);
  const chunks = [];
  for await (const data of res) chunks.push(data);
  return {status:res.statusCode, body:JSON.parse(Buffer.concat(chunks))};
}

test('paired HTTPS access can read the account but never receives desktop login, device-management or approval credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codecang-remote-management-'));
  const client = new DemoClient();
  const calls = [];
  const originalCall = client.call.bind(client);
  client.call = async (method, params) => {
    calls.push(method);
    if (method === 'account/login/start') return {type:'chatgptDeviceCode', loginId:'private-login-id',
      verificationUrl:'https://auth.openai.com/device', userCode:'PRIVATE-HANDOFF'};
    if (method === 'account/login/cancel') return {status:'canceled'};
    if (method === 'account/usage/read') return {usage:[]};
    if (method === 'remoteControl/pairing/start') return {pairingCode:'PRIVATE-PAIRING', expiresAt:Math.floor(Date.now()/1000)+60};
    return originalCall(method, params);
  };
  const app = await createServer({client, projectsRoot:join(root,'projects'), statisticsRoot:join(root,'statistics'),
    fileAttachmentRoot:join(root,'attachments'), cwd:root});
  t.after(async () => { await app.close(); await rm(root, {recursive:true, force:true}); });
  await app.started;
  const desktop = {origin:app.origin, port:app.server.address().port, token:app.token};
  const available = http.createServer().listen(0, '127.0.0.1');
  await once(available, 'listening');
  const port = available.address().port;
  await new Promise(resolve => available.close(resolve));
  const origin = 'https://paired.example.com';
  const enabled = await json(desktop, '/api/lan/tunnel/enable', {publicOrigin:origin, port});
  assert.equal(enabled.status, 200);
  const remote = {port, origin, token:new URLSearchParams(new URL(enabled.body.url).hash.slice(1)).get('token')};
  const instance = (await json(desktop, '/api/status')).body.serverInstance;
  const requestId = suffix => `${instance}:${Date.now()}:${suffix}`;
  const call = (target, method, params={}, extras={}) => json(target, '/api/rpc', {method, params, ...extras});
  for (const method of ['account/read', 'account/rateLimits/read', 'account/usage/read']) {
    assert.equal((await call(remote,method)).status, 200, method);
  }
  const before = calls.length;
  for (const method of [...REMOTE_METHODS, 'account/rateLimitResetCredit/consume']) {
    assert.equal((await call(remote,method,{}, {confirmed:true})).status, 403, method);
  }
  for (const action of ['start','cancel','logout','snapshot']) {
    assert.equal((await json(remote,'/api/account/' + action,{})).status, 403);
  }
  assert.equal(calls.length, before);

  const id = requestId('account-operation'), pairId = requestId('pairing-operation');
  assert.equal((await json(desktop, '/api/account/start', {type:'chatgptDeviceCode', requestId:id})).body.userCode, 'PRIVATE-HANDOFF');
  assert.equal((await call(desktop,'remoteControl/pairing/start',{}, {requestId:pairId,confirmed:true})).body.pairingCode, 'PRIVATE-PAIRING');
  for (const operationId of [id, pairId]) {
    const path = '/api/operations?requestId=' + encodeURIComponent(operationId);
    assert.equal((await json(desktop,path)).body.state, 'succeeded');
    assert.equal((await json(remote,path)).status, 403);
  }
  assert.equal((await json(desktop,'/api/account/snapshot',{})).body.loginId, 'private-login-id');

  const sensitive = {id:'private-request',method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:'PRIVATE-ACCOUNT'}};
  client.requests.set(sensitive.id, sensitive);
  const ownerRequest = (await json(desktop,'/api/status')).body.pendingRequests.find(r=>r.id===sensitive.id);
  assert.ok(ownerRequest.bridgeRequestToken);
  assert.equal((await json(remote,'/api/status')).body.pendingRequests.some(r=>r.id===sensitive.id), false);
  assert.equal((await json(remote,'/api/respond',{id:sensitive.id,bridgeRequestToken:ownerRequest.bridgeRequestToken,error:{code:-32601}})).status,403);
  const stream = await open(remote, '/api/events');
  try {
    client.emit('event',sensitive);
    client.emit('event',{method:'remoteControl/status/changed',params:{serverName:'PRIVATE-DEVICE'}});
    await json(desktop,'/api/account/cancel',{requestId:requestId('cancel-operation'),loginId:'private-login-id'});
    client.emit('event',{method:'account/updated',params:{authMode:'chatgpt'}});
    stream.setTimeout(4000, () => stream.destroy(new Error('read-only account update timed out')));
    let received = '';
    for await (const chunk of stream) {
      received += chunk;
      if (received.includes('account/updated')) break;
    }
    assert.match(received,/account\/updated/);
    assert.doesNotMatch(received,/PRIVATE-|private-login-id|private-request|bridge\/accountLogin|remoteControl\//);
  } finally { stream.destroy(); }
});
