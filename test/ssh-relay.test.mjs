import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { generateKeyPairSync, createHmac } from 'node:crypto';
import { SshRelay } from '../src/ssh-relay.mjs';

const hostId = '1234567890abcdef'.repeat(2);
const hostKey = 'ssh-ed25519 ' + Buffer.concat([
  Buffer.from('0000000b7373682d6564323535313900000020', 'hex'),
  generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
]).toString('base64');
const meta = { hostId, hostKey, relayPort: 49721 };
const sign = nonce => createHmac('sha256', 'local-test-key').update('codecang-relay-v1:' + nonce).digest('hex');
const inputs = { port: 19876, publicOrigin: 'https://relay.example.org', hostId, verifyRelayProof: (n, p) => sign(n) === p };
const metadataPath = '/.well-known/codecang-relay';

async function waitFor(check) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await pause(10);
  }
  assert.fail('timed out waiting for relay state');
}

async function fixture(t, response, timing = {}) {
  const keyDir = await mkdtemp(path.join(os.tmpdir(), 'codecang relay '));
  const calls = [], children = [];
  const relay = new SshRelay({
    keyDir, maxAttempts: 1, connectTimeoutMs: 2500, ...timing,
    request(url, options, cb) {
      const req = new EventEmitter();
      req.end = body => {
        calls.push({ url, options, body });
        queueMicrotask(() => {
          const reply = response(url.pathname, body);
          const stream = Readable.from([Buffer.from(reply.raw ?? JSON.stringify(reply.json))]);
          stream.statusCode = reply.status ?? 200;
          stream.headers = reply.headers || {};
          cb(stream);
        });
      };
      return req;
    },
    spawnProcess(file, args, options) {
      const child = new EventEmitter();
      child.stderr = new PassThrough();
      const [, relayPort,, port] = args[args.indexOf('-R') + 1].split(':');
      child.confirm = () => child.stderr.write('debug1: ssh.c:ssh_confirm_remote_forward():1730 (pid=743): remote forward success for: listen 127.0.0.1:'
        + relayPort + ', connect 127.0.0.1:' + port + '\r\n');
      if (timing.autoConfirm !== false) queueMicrotask(child.confirm);
      child.kill = () => { child.killed = true; if (!child.delayExit) queueMicrotask(() => child.emit('close')); };
      children.push(Object.assign(child, { file, args, options }));
      return child;
    },
  });
  t.after(async () => { await relay.close(); await rm(keyDir, { recursive: true, force: true }); });
  return { keyDir, relay, calls, children };
}

test('relay pins per-host metadata, confirms the restricted origin and waits for old SSH to close before replacing it', async t => {
  let allowProof = false;
  const { keyDir, relay, calls, children } = await fixture(t, (route, body) =>
    route === metadataPath ? { json: meta } : { json: { proof: allowProof ? sign(JSON.parse(body).nonce) : '0'.repeat(64) } }, { autoConfirm: false });
  const { script } = await relay.prepare(inputs);
  assert.ok(script.includes(hostId));
  assert.ok(!script.includes('PRIVATE KEY'));
  await waitFor(() => children.length > 0);
  assert.equal(relay.status.state, 'connecting');
  assert.equal(children.length, 1);
  const [child] = children;
  child.stderr.write('debug1: remote forward success for: listen 127.0.0.1:49721, connect 127.0.0.1:19876\r\n');
  assert.equal(calls.some(call => call.body), false);
  child.confirm();
  await waitFor(() => calls.some(call => call.body));
  for (const option of ['-N', '-T', '-F', 'none', 'StrictHostKeyChecking=yes', 'IdentityAgent=none',
    'GlobalKnownHostsFile=none', 'ExitOnForwardFailure=yes', '127.0.0.1:49721:127.0.0.1:19876']) assert.ok(child.args.includes(option), option);
  assert.equal(child.args.at(-1), 'codecang-tunnel@relay.example.org');
  const connectionDir = (await readdir(keyDir)).find(name => name.startsWith('connection-'));
  assert.equal(await readFile(path.join(keyDir, connectionDir, 'known_hosts'), 'utf8'), '[relay.example.org]:49323 ' + hostKey + '\n');
  allowProof = true;
  await waitFor(() => relay.status.state === 'connected');
  for (const call of calls) {
    assert.equal(call.options.rejectUnauthorized, true);
    assert.equal(call.url.origin, inputs.publicOrigin);
    if (call.body) {
      assert.equal(call.url.pathname, '/api/pairing/prove');
      assert.equal(call.options.method, 'POST');
      assert.match(call.body, /^\{"nonce":"[a-f0-9]{32}"\}$/);
    }
  }
  const challengeBodies = calls.filter(call => call.body).map(call => call.body);
  assert.ok(challengeBodies.length >= 2);
  assert.equal(new Set(challengeBodies).size, challengeBodies.length);
  assert.equal((await relay.prepare(inputs)).script, script);
  child.delayExit = true;
  let stopped = false;
  const stopping = relay.stop().then(() => { stopped = true; });
  const next = relay.prepare({ ...inputs, port: 19877 });
  await pause(30);
  assert.ok(child.killed && !stopped);
  assert.equal(children.length, 1);
  child.emit('exit', 1); // Windows IPC owners can exit without a subsequent close event.
  await stopping;
  assert.equal((await next).script, script);
  await waitFor(() => children.length > 1);
  children[1].confirm();
  await waitFor(() => relay.status.state === 'connected');
  assert.ok(children[1].args.includes('127.0.0.1:49721:127.0.0.1:19877'));
  await relay.close();
  assert.deepEqual(await readdir(keyDir), ['id_ed25519']);
  await assert.rejects(relay.prepare(inputs), /已关闭/);
});

test('relay rejects redirects, oversized or malformed metadata, different host IDs and forbidden ports before SSH', async t => {
  let response;
  const { relay, children, calls } = await fixture(t, () => response);
  for (response of [
    { status: 302, json: meta }, { raw: 'a'.repeat(2048) }, { raw: '{' }, { json: { ...meta, hostId: '0'.repeat(32) } },
    ...[49321, 49323, 50000, '49721'].map(relayPort => ({ json: { ...meta, relayPort } })),
    { json: { ...meta, hostKey: 'ssh-ed25519 ' + 'A'.repeat(68) } },
  ]) {
    await relay.prepare(inputs);
    await waitFor(() => relay.status.state === 'error');
    assert.equal(children.length, 0);
  }
  assert.equal(calls.length, 9);
});

test('relay never claims connection when the public endpoint returns the wrong proof', async t => {
  const { relay, children } = await fixture(t, route =>
    route === metadataPath ? { json: meta } : { json: { proof: '0'.repeat(64) } }, { connectTimeoutMs: 80 });
  await relay.prepare(inputs);
  await waitFor(() => relay.status.state === 'error');
  assert.ok(children[0].killed);
});

test('a web page at the metadata address reports the error while retrying, then uses the advertised SSH port', async t => {
  let fixed=false;
  const {relay,children,calls,keyDir}=await fixture(t,(route,body)=>{
    if(route!==metadataPath) return {json:{proof:sign(JSON.parse(body).nonce)}};
    return fixed ? {json:{...meta,sshPort:23456}} : {headers:{'content-type':'text/html; charset=utf-8'},raw:'<html></html>'};
  },{maxAttempts:4,retryDelayMs:120});
  await relay.prepare({...inputs,publicOrigin:'https://relay.example.org:25443'});
  await waitFor(()=>relay.status.state==='retrying');
  assert.match(relay.status.message,/网页/);assert.equal(children.length,0);
  fixed=true;
  await waitFor(()=>relay.status.state==='connected');
  assert.ok(calls.every(call=>call.url.port==='25443'));
  assert.equal(children[0].args[children[0].args.indexOf('-p')+1],'23456');
  const dir=(await readdir(keyDir)).find(name=>name.startsWith('connection-'));
  assert.match(await readFile(path.join(keyDir,dir,'known_hosts'),'utf8'),/^\[relay\.example\.org\]:23456 /);
});

test('a persistent relay reconnects after the initial attempt budget during an outage',async t=>{
  let attempts=0;
  const {relay}=await fixture(t,(route,body)=>route===metadataPath
    ? ++attempts<3 ? {status:503,json:{}} : {json:meta}
    : {json:{proof:sign(JSON.parse(body).nonce)}},{keepConnected:true,maxAttempts:1,retryDelayMs:5});
  await relay.prepare(inputs);
  await waitFor(()=>relay.status.state==='connected');
  assert.equal(attempts,3);
});

test('native OpenSSH connection closes after abrupt desktop process exit', async t => {
  const listener = createServer();
  const sockets = new Set();
  let received = false;
  listener.on('connection', socket => {
    sockets.add(socket);
    socket.on('data', () => { received = true; });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const program = `
    require('node:child_process').fork(process.argv[1], ['--own-ssh', '-F', 'none', '-N', '-T',
      '-o', 'BatchMode=yes', '-p', process.argv[2], '127.0.0.1'], { stdio: ['ignore','ignore','ignore','ipc'], execArgv: [] });
  `;
  const desktop = spawn(process.execPath, ['-e', program, fileURLToPath(new URL('../src/ssh-relay.mjs', import.meta.url)),
    String(listener.address().port)], { stdio: 'ignore', windowsHide: true });
  t.after(() => {
    desktop.kill();
    for (const socket of sockets) socket.destroy();
    listener.close();
  });
  await waitFor(() => received);
  desktop.kill('SIGKILL');
  await waitFor(() => sockets.size === 0);
});
