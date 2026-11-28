import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.mjs';
import { LanAccess } from '../src/lan-access.mjs';
import { LanPreferenceStore } from '../src/lan-preferences.mjs';
import { setTimeout as pause } from 'node:timers/promises';

const loopback = '127.0.0.1';
const publicOrigin = 'https://phone.example.com';
const lanAddress = '192.168.90.12';

function fragment(link, name) {
  const value = new URLSearchParams(new URL(link).hash.slice(1)).get(name);
  assert.ok(value);
  return value;
}

async function listen(server) {
  server.listen(0, loopback);
  await once(server, 'listening');
  return server.address().port;
}

async function availablePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(t, options = {}) {
  const app = await createServer({
    demo: true,
    desktop: true,
    lanOptions: {
      networkInterfaces: () => ({ Synthetic: [{ address: lanAddress, family: 'IPv4', internal: false }] }),
      serverFactory: handler => {
        const server = http.createServer(handler);
        const listen = server.listen.bind(server);
        server.listen = options => listen({ ...options, host: loopback });
        return server;
      },
    },
    ...options,
  });
  t.after(() => app.close());
  await app.started;
  return app;
}

// Preserve the public Host/Origin just as an HTTP edge does after terminating TLS.
// All test connections, including the simulated LAN listener, stay on loopback.
async function proxy(t, targetPort) {
  const server = http.createServer((req, res) => {
    const upstream = http.request({
      hostname: loopback, port: targetPort, method: req.method, path: req.url, headers: req.headers, agent: false,
    }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502).end();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return port;
}

function open(port, origin, pathname, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: loopback, port, path: pathname, method: body === undefined ? 'GET' : 'POST', agent: false,
      headers: {
        Host: new URL(origin).host, Origin: origin,
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
      },
    }, resolve);
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function request(port, origin, path, options) {
  const res = await open(port, origin, path, options);
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  return { status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) };
}

function manage(app, action, body = {}, token = app.token, headers) {
  return request(app.server.address().port, app.origin, '/api/lan/' + action, { token, body, headers });
}

async function enable(app, publicUrl = publicOrigin) {
  const port = await availablePort();
  const result = await manage(app, 'tunnel/enable', { publicOrigin: publicUrl, port });
  assert.equal(result.status, 200);
  const state = result.json();
  assert.equal(state.address, loopback);
  assert.equal(state.port, port);
  assert.equal(state.origin, new URL(publicUrl).origin);
  assert.equal(new URL(state.url).origin, state.origin);
  return state;
}

test('desktop restart and a changed project profile retain the authenticated computer identity', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'codecang-restart-id-'));
  const state=path.join(root,'state');
  try{
    const before=await fixture(t,{desktopStateRoot:state,projectsRoot:path.join(root,'old-profile')});
    const first=(await request(before.server.address().port,before.origin,'/api/status',{token:before.token})).json();
    await before.close();
    const after=await fixture(t,{desktopStateRoot:state,projectsRoot:path.join(root,'new-profile')});
    const second=(await request(after.server.address().port,after.origin,'/api/status',{token:after.token})).json();
    assert.match(first.remoteHostId,/^[0-9a-f]{32}$/);
    assert.equal(second.remoteHostId,first.remoteHostId);
    assert.notEqual(second.serverInstance,first.serverInstance);
    await after.close();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('saved form and paired phone survive desktop restart; rotation and disabling survive another restart', {skip:process.platform!=='win32'}, async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'codecang-tunnel-settings-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new LanPreferenceStore({root:path.join(root,'state','remote-access'),tunnel:true});
  const options={desktopStateRoot:path.join(root,'state'),tunnelPreferenceStore:store};
  const before=await fixture(t,{...options,projectsRoot:path.join(root,'old-profile')});
  const settings={provider:'frp',publicOrigin:publicOrigin+':9443',port:await availablePort(),randomPorts:false};
  assert.equal((await manage(before,'tunnel/settings',settings,null)).status,401);
  assert.equal((await manage(before,'tunnel/settings',settings)).status,200);
  const enabled=await manage(before,'tunnel/enable',{publicOrigin:settings.publicOrigin,port:settings.port});
  assert.equal(enabled.status,200);
  const issued=await manage(before,'tunnel/pairing');
  const phone=await request(settings.port,settings.publicOrigin,'/api/pairing/redeem',{body:{ticket:fragment(issued.json().url,'pair')}});
  assert.equal(phone.status,200);
  const token=phone.json().token;
  assert.ok(!(await readFile(store.file)).includes(Buffer.from(token)));
  assert.equal((await manage(before,'tunnel/settings',{...settings,token:'unexpected'})).status,400);
  assert.deepEqual(JSON.parse(await readFile(path.join(options.desktopStateRoot,'remote-access','tunnel-settings.json'),'utf8')),settings);
  await before.close();
  const after=await fixture(t,{...options,projectsRoot:path.join(root,'new-profile')});
  const status=await restoredStatus(after);
  assert.deepEqual(status.settings,settings);
  assert.equal(status.enabled,true);
  const check=token=>request(settings.port,settings.publicOrigin,'/api/status',{token});
  assert.equal((await check(token)).status,200);
  const rotated=fragment((await manage(after,'tunnel/rotate')).json().url,'token');
  await after.close();
  const third=await fixture(t,options);
  await restoredStatus(third);
  assert.equal((await check(token)).status,401);
  assert.equal((await check(rotated)).status,200);
  assert.equal((await manage(third,'tunnel/disable')).status,200);
  await third.close();
  const stopped=await fixture(t,options);
  const disabled=await restoredStatus(stopped);
  assert.equal(disabled.enabled,false);
  assert.deepEqual(disabled.settings,settings);
});

async function restoredStatus(app){
  const deadline=Date.now()+10000;
  do{
    const status=(await manage(app,'tunnel/status')).json();
    if(!status.restoring)return status;
    await pause(25);
  }while(Date.now()<deadline);
  assert.fail('desktop did not finish restoring public access');
}

test('startup restores the selected SSH relay and manual disconnect keeps only the public listener',async t=>{
  let saved=null;
  const store={read:async()=>saved,write:async v=>{saved=v;}};
  let starts=0;
  const relay={prepare:async()=>{starts++;return {};},stop:async()=>{},close:async()=>{}};
  const root=await mkdtemp(path.join(os.tmpdir(),'codecang-ssh-restore-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const options={tunnelPreferenceStore:store,sshRelayService:relay,desktopStateRoot:root};
  const first=await fixture(t,options);
  const port=await availablePort();
  assert.equal((await manage(first,'tunnel/ssh/connect',{publicOrigin,port,previousOrigin:null})).status,200);
  assert.equal(starts,1);
  const draft={provider:'ssh',publicOrigin:'https://another.example.com',port,randomPorts:true};
  assert.equal((await manage(first,'tunnel/settings',draft)).status,200);
  await first.close();
  const second=await fixture(t,options);
  assert.equal((await restoredStatus(second)).origin,publicOrigin);
  assert.equal(starts,2);
  assert.equal((await manage(second,'tunnel/ssh/stop')).status,200);
  await second.close();
  const third=await fixture(t,options);
  assert.equal((await restoredStatus(third)).enabled,true);
  assert.equal(starts,2);
});

test('busy public port recovers with the original pairing when the previous listener exits',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const port=await availablePort();
  let saved={version:1,port,publicOrigin,ssh:false,token:'d'.repeat(64)};
  const manager=new LanAccess({tunnel:true,handler:(_req,res)=>res.end(),preferenceStore:{
    read:async()=>saved,write:async value=>{saved=value;},
  }});
  t.after(()=>manager.close());
  const blocker=http.createServer();
  blocker.listen(port,loopback);await once(blocker,'listening');
  try{const waiting=await manager.restore();assert.equal(waiting.retryScheduled,true);assert.equal(waiting.enabled,false);}
  finally{await new Promise(resolve=>blocker.close(resolve));}
  t.mock.timers.tick(5000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(manager.status().port,port);
  assert.equal(fragment(manager.status().url,'token'),saved.token);
});

async function ticket(app, action = 'tunnel/pairing') {
  const issued = await manage(app, action);
  assert.equal(issued.status, 200);
  const { url, expiresAt } = issued.json();
  assert.ok(expiresAt > Date.now());
  if (action === 'tunnel/pairing') assert.equal(new URL(url).origin, publicOrigin);
  return fragment(url, 'pair');
}

test('only the desktop owner can enable a dedicated, explicitly configured HTTPS tunnel listener', async t => {
  const app = await fixture(t);
  assert.equal((await manage(app, 'tunnel/status')).json().enabled, false);
  const port = await availablePort();
  assert.equal((await manage(app, 'tunnel/enable', { publicOrigin, port }, null)).status, 401);
  assert.equal((await manage(app, 'tunnel/enable', { publicOrigin, port }, app.token, { Origin: publicOrigin })).status, 403);
  for (const invalid of [
    'http://phone.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost',
    'https://x.trycloudflare.com', 'https://user@phone.example.com', publicOrigin + '/subpath',
    publicOrigin + '?query=1', publicOrigin + '#fragment',
  ]) {
    assert.equal((await manage(app, 'tunnel/enable', { publicOrigin: invalid, port })).status, 400, invalid);
  }
  for (const invalid of [undefined, 0, -1, 1.5, '45123', 65536]) {
    assert.equal((await manage(app, 'tunnel/enable', { publicOrigin, port: invalid })).status, 400);
  }
  const occupied = await manage(app, 'tunnel/enable', { publicOrigin, port: app.server.address().port });
  assert.ok(occupied.status >= 400, 'an occupied port must fail without changing the listener');
  assert.equal(occupied.json().notExecuted, true);
  assert.equal((await manage(app, 'tunnel/status')).json().enabled, false);
  const first = await enable(app, publicOrigin + ':443/');
  assert.equal((await manage(app, 'tunnel/status')).json().url, first.url);
  await manage(app, 'tunnel/disable');
  await enable(app, publicOrigin + ':8443');
});

test('changing a relay address keeps its listener, revokes the previous pairing, and rejects stale edits', async t => {
  const tunnel=new LanAccess({tunnel:true,handler:(_req,res)=>res.end('ready')});
  t.after(()=>tunnel.close());
  const port=await availablePort();
  const first=await tunnel.configureTunnel({publicOrigin,port},null);
  const ticket=fragment(tunnel.pairing().url,'pair');
  const target=publicOrigin+':25443';
  const next=await tunnel.configureTunnel({publicOrigin:target,port},first.origin);
  assert.equal(next.port,first.port);
  assert.notEqual(fragment(next.url,'token'),fragment(first.url,'token'));
  assert.equal((await request(port,first.origin,'/api/status',{token:fragment(first.url,'token')})).status,403);
  assert.equal((await request(port,next.origin,'/api/pairing/redeem',{body:{ticket}})).status,401);
  assert.equal((await request(port,next.origin,'/api/status',{token:fragment(next.url,'token')})).status,200);
  await assert.rejects(tunnel.configureTunnel({publicOrigin,port},first.origin),/已变更/);
  assert.equal((await tunnel.configureTunnel({publicOrigin:target,port},next.origin)).url,next.url);
});

test('proxy preserves remote restrictions and requires the correct host, origin and listener credential', async t => {
  const app = await fixture(t);
  const state = await enable(app);
  const edge = await proxy(t, state.port);
  const lan = (await manage(app, 'enable', { address: lanAddress })).json();
  const token = fragment(state.url, 'token');
  const lanToken = fragment(lan.url, 'token');
  assert.equal(new Set([token, lanToken, app.token]).size, 3);
  const remote = (path = '/api/status', options = {}) => request(edge, publicOrigin, path, { token, ...options });
  assert.equal((await remote('/', { token: null })).status, 200);
  const status = (await remote()).json();
  const owner = await request(app.server.address().port, app.origin, '/api/lan/tunnel/status', {token:app.token});
  const localId = owner.json().remoteHostId;
  assert.match(localId, /^[0-9a-f]{32}$/);
  assert.equal(owner.json().sshRelay.state, 'off');
  assert.equal(status.remoteHostId, localId);
  assert.equal((await remote()).headers['x-codecang-remote-host-id'], localId);
  assert.equal((await request(lan.port, lan.origin, '/api/status', {token:lanToken})).json().remoteHostId, localId);
  assert.equal((await remote('/api/status', {token:null})).headers['x-codecang-remote-host-id'], undefined);
  assert.notEqual((await manage(await fixture(t),'tunnel/status')).json().remoteHostId, localId);
  assert.equal(status.desktop, false);
  assert.equal(status.reopenAvailable, false);
  assert.equal(status.serverInstance, app.operations.serverInstance);
  for (const invalid of [null, lanToken, app.token]) assert.equal((await remote('/api/status', { token: invalid })).status, 401);
  assert.equal((await request(lan.port, lan.origin, '/api/status', { token })).status, 401);
  assert.equal((await manage(app, 'tunnel/status', {}, token)).status, 401);
  for (const path of ['/api/lan/tunnel/status', '/api/lan/tunnel/enable','/api/lan/tunnel/ssh/prepare','/api/lan/tunnel/ssh/stop', '/api/lan/status', '/api/shutdown','/api/statistics/import','/api/local-usage/scan',
    '/api/desktop/pick-folder', '/api/runtime/status', '/api/app-update/status', '/api/dsh/connection/status']) {
    assert.equal((await remote(path, { body: {} })).status, 403, path);
  }
  const forged = { 'X-Forwarded-Host': new URL(publicOrigin).host, 'X-Forwarded-Proto': 'https',
    'Forwarded': 'proto=https;host=' + new URL(publicOrigin).host };
  assert.equal((await remote('/api/status', { headers: { ...forged, Host: loopback + ':' + state.port } })).status, 403);
  assert.equal((await remote('/api/status', { headers: { ...forged, Origin: 'https://another.example.com' } })).status, 403);
  assert.equal((await remote('/api/lan/tunnel/status', { body: {}, headers: { 'X-Forwarded-For': loopback } })).status, 403);
  assert.equal((await remote()).status, 200);
});

test('proxied QR redemption is one-time and isolated from LAN tickets and cancellation', async t => {
  const app = await fixture(t);
  const state = await enable(app);
  const edge = await proxy(t, state.port);
  const lan = (await manage(app, 'enable', { address: lanAddress })).json();
  const redeem = (port, origin, code, headers) => request(port, origin, '/api/pairing/redeem', { body: { ticket: code }, headers });
  const code = await ticket(app);
  const lanCode = await ticket(app, 'pairing');
  assert.equal((await redeem(edge, publicOrigin, code, { Origin: lan.origin })).status, 403);
  assert.equal((await redeem(edge, publicOrigin, lanCode)).status, 401);
  assert.equal((await redeem(lan.port, lan.origin, code)).status, 401);
  const results = await Promise.all([redeem(edge, publicOrigin, code), redeem(edge, publicOrigin, code)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
  const success = results.find(result => result.status === 200);
  assert.equal(success.headers['cache-control'], 'no-store');
  assert.equal(success.json().token, fragment(state.url, 'token'));
  const cancelled = await ticket(app);
  assert.equal((await manage(app, 'tunnel/cancelPairing')).status, 200);
  assert.equal((await redeem(edge, publicOrigin, cancelled)).status, 401);
  assert.equal((await redeem(lan.port, lan.origin, lanCode)).status, 200);
});

async function eventStream(t, edge, token) {
  const res = await open(edge, publicOrigin, '/api/events', { token });
  t.after(() => res.destroy());
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  res.on('error', () => {}); // Closing the listener intentionally resets the TCP stream.
  const closed = new Promise(resolve => res.once('close', resolve));
  return { res, closed };
}

test('SSE crosses the proxy live, and rotation, disable and desktop shutdown revoke existing connections', { timeout: 12000 }, async t => {
  const app = await fixture(t);
  const state = await enable(app);
  const token = fragment(state.url, 'token');
  const edge = await proxy(t, state.port);
  const lan = (await manage(app, 'enable', { address: lanAddress })).json();
  const lanToken = fragment(lan.url, 'token');
  const first = await eventStream(t, edge, token);
  const liveEvent = new Promise(resolve => {
    let received = '';
    first.res.on('data', chunk => {
      received += chunk;
      if (received.includes('test/tunnelLiveEvent')) resolve();
    });
  });
  app.rpc.emit('event', { method: 'test/tunnelLiveEvent', params: {} });
  await liveEvent;
  const pending = await ticket(app);
  const rotated = (await manage(app, 'tunnel/rotate')).json();
  await first.closed;
  const freshToken = fragment(rotated.url, 'token');
  assert.notEqual(freshToken, token);
  assert.equal((await request(edge, publicOrigin, '/api/status', { token })).status, 401);
  assert.equal((await request(edge, publicOrigin, '/api/pairing/redeem', { body: { ticket: pending } })).status, 401);
  const second = await eventStream(t, edge, freshToken);
  assert.equal((await manage(app, 'tunnel/disable')).json().enabled, false);
  await second.closed;
  await assert.rejects(request(state.port, publicOrigin, '/'), { code: 'ECONNREFUSED' });
  assert.equal((await request(lan.port, lan.origin, '/api/status', { token: lanToken })).status, 200);
  const newSession = (await manage(app, 'tunnel/enable', { publicOrigin, port: state.port })).json();
  assert.notEqual(fragment(newSession.url, 'token'), freshToken);
  assert.equal((await request(edge, publicOrigin, '/api/status', { token: freshToken })).status, 401);
  const last = await eventStream(t, edge, fragment(newSession.url, 'token'));
  await app.close();
  await last.closed;
  await assert.rejects(request(state.port, publicOrigin, '/'), { code: 'ECONNREFUSED' });
});
