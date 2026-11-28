import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRelayInstaller, buildRelaySetupScript, createRelaySourceCheck } from '../src/ssh-relay-script.mjs';

function publicKey(byte) {
  const wire = Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020', 'hex'), Buffer.alloc(32, byte)]);
  return 'ssh-ed25519 ' + wire.toString('base64');
}

const first = { hostname: 'one.example.com', publicKey: publicKey(1), hostId: 'a'.repeat(32), sshPort: 49323 };
const second = { ...first, hostname: 'two.example.com', publicKey: publicKey(2), hostId: 'b'.repeat(32) };
const script = buildRelaySetupScript(first);
const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
const bashAvailable = spawnSync(bash, ['--version']).status === 0;

test('online installation pins the packaged release script and unverified versions use the bundled copy',async()=>{
  const original=await readFile(new URL('../src/relay-setup.sh',import.meta.url));
  const {command,script:local}=buildRelayInstaller(first);
  assert.ok(command.includes(createHash('sha256').update(original).digest('hex')));
  assert.ok(command.includes('sha256sum -c - && bash'));assert.equal(command.includes('\n'),false);
  assert.ok(local.includes(original.toString('utf8').trimEnd()));
  let reads=0;
  const available=createRelaySourceCheck(async url=>{
    reads++;assert.match(url,/^https:\/\/raw\.githubusercontent\.com\/k08255-lxm\/codex-light\/v\d+\.\d+\.\d+\/src\/relay-setup\.sh$/);
    return new Response(original);
  });
  assert.deepEqual(await Promise.all([available(),available()]),[true,true]);
  assert.equal(await available(),true);assert.equal(reads,1);
  for(const response of [new Response('missing',{status:404}),new Response('different script')]){
    assert.equal(await createRelaySourceCheck(async()=>response)(),false);
  }
  if(bashAvailable)assert.equal(spawnSync(bash,['-n'],{input:command}).status,0);
});

test('entry detection respects active relays, installed proxies and listening or reserved ports', {skip:!bashAvailable}, async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'codecang-entry-mode-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const choose=script.slice(script.indexOf('choose_entry() {'),script.indexOf('\nchoose_entry\n'));
  const run=preflight=>spawnSync(bash,['-c',[
    'set -eu; base=.; web=ours; fail(){ exit 8; }; systemctl(){ return 1; }; ss(){ :; }',
    choose,preflight,'choose_entry; printf "%s" "$entry"'
  ].join('\n')],{cwd:root,encoding:'utf8'});
  assert.equal(run('command(){ if [[ "$1" == -v ]]; then return 1; fi; builtin command "$@"; }').stdout,'direct');
  assert.equal(run('nginx(){ :; }; caddy(){ :; }').stdout,'49152');
  assert.equal(run('ss(){ if [[ "$2" == *":80 "* || "$2" == "sport = :49152" ]]; then echo LISTEN; fi; }').stdout,'49153');
  assert.equal(run('caddy(){ :; }; systemctl(){ [[ "$3" == ours ]]; }').stdout,'direct');
  await writeFile(path.join(root,'web-entry'),'49201\n');assert.equal(run('nginx(){ :; }').stdout,'49201');
  await writeFile(path.join(root,'web-entry'),'invalid\n');assert.notEqual(run(':').status,0);
});

function section(start, end) {
  const from = script.indexOf(start + '\n');
  const to = script.indexOf('\n' + end + '\n', from + start.length);
  assert.ok(from >= 0 && to > from);
  return script.slice(from + start.length + 1, to);
}

test('script accepts only a canonical DNS host, a fixed-size device ID and a complete Ed25519 wire key', () => {
  for (const hostname of ['localhost', '127.0.0.1', '127.1', '[::1]', 'bad.localhost', 'x.trycloudflare.com',
    'bad.example:443', 'good.example/nearby', 'x\n.example', 'a'.repeat(64) + '.example', "bad'.example"]) {
    assert.throws(() => buildRelaySetupScript({ ...first, hostname }));
  }
  for (const input of [publicKey(1) + ' comment', publicKey(1) + '\n', 'ssh-ed25519 ' + Buffer.alloc(51).toString('base64'),
    'ssh-ed25519 AAAA', 'ssh-rsa AAAA', '-----BEGIN PRIVATE KEY-----']) {
    assert.throws(() => buildRelaySetupScript({ ...first, publicKey: input }));
  }
  for (const hostId of ['x'.repeat(32), '0'.repeat(31), first.hostId + '\n', 'a;exit']) {
    assert.throws(() => buildRelaySetupScript({ ...first, hostId }));
  }
  assert.throws(() => buildRelaySetupScript({ ...first, sshPort: 22 }));
  assert.match(script, /AddressFamily any/);
  for (const directive of ['AuthenticationMethods publickey', 'AllowUsers codecang-tunnel', 'AllowTcpForwarding remote',
    'PermitListen 127.0.0.1:*', 'GatewayPorts no', 'MaxSessions 0', 'AllowStreamLocalForwarding no', 'PermitOpen none',
    'PermitTTY no', 'AllowAgentForwarding no', 'X11Forwarding no']) assert.ok(script.includes('\n' + directive + '\n'), directive);
  assert.doesNotMatch(script, /BEGIN .*PRIVATE KEY|sudoers|--privileged|ufw |iptables |\/etc\/ssh\/sshd_config/);
});

// Opt in with a local Caddy binary to exercise a real proxy without public DNS,
// automatic certificate issuance or installation of a test root CA.
test('real Caddy serves the generated metadata on IPv4/IPv6 and preserves SSE across a second registration', {
  skip: !process.env.CODECANG_TEST_CADDY_BIN || !bashAvailable, timeout: 35000,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codecang-relay-https-'));
  let child, stopped, backend, event;
  t.after(async () => {
    event?.destroy();
    if (child?.pid) {
      if (child.exitCode === null && !child.signalCode) child.kill();
      await stopped;
    }
    if (backend?.listening) {
      backend.closeAllConnections();
      await new Promise(resolve => backend.close(resolve));
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const absolute = name => path.join(root, name).replaceAll('\\', '/');
  const openssl = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/usr/bin/openssl.exe') : 'openssl';
  const cert = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=one.example.com',
    '-addext', 'subjectAltName=DNS:one.example.com,DNS:two.example.com', '-keyout', 'key.pem', '-out', 'cert.pem'], { cwd: root });
  assert.equal(cert.status, 0, cert.stderr?.toString());
  const ca = await readFile(path.join(root, 'cert.pem'));
  for (const dir of ['devices', 'ssh']) await mkdir(path.join(root, dir));
  await writeFile(path.join(root, 'host.pub'), publicKey(77) + '\n');
  await writeFile(path.join(root, 'routes.sh'), section('cat > "$base/routes.sh" <<\'ROUTES\'', 'ROUTES'));
  const reserve = async () => {
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return port;
  };
  const adminPort = await reserve(), publicPort = await reserve();
  let stream;
  backend = http.createServer((req, res) => {
    if (req.url === '/stream') {
      stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
    } else res.end(req.headers.host);
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  async function configure(entry, generation) {
    await writeFile(path.join(root, 'devices', entry.hostId), [entry.hostname, entry.publicKey, backend.address().port, ''].join('\n'));
    const rendered = spawnSync(bash, ['-c', 'set -eu; base=.; . routes.sh; render_routes "$1"', 'test', generation], { cwd: root, encoding: 'utf8' });
    assert.equal(rendered.status, 0, rendered.stderr);
    const configName = path.join(root, generation, 'Caddyfile');
    const main = (await readFile(configName, 'utf8')).replace('unix//run/codecang-caddy.sock', '127.0.0.1:' + adminPort + '\n    auto_https disable_redirects')
      .replace(/import \/relay\/(.*)/, (_, suffix) => 'import "' + absolute(suffix) + '"');
    await writeFile(configName, main);
    for (const site of await readdir(path.join(root, generation, 'sites'))) {
      const file = path.join(root, generation, 'sites', site);
      const original = await readFile(file, 'utf8');
      const local = original.replace(/^(\S+) \{/, (_, host) => host + ':' + publicPort + ' {\n    bind 127.0.0.1 ::1\n    tls "' + absolute('cert.pem') + '" "' + absolute('key.pem') + '"')
        .replace(/root \* \/relay\/(\S+)/, (_, suffix) => 'root * "' + absolute(suffix) + '"');
      await writeFile(file, local);
    }
    return configName;
  }
  const caddy = process.env.CODECANG_TEST_CADDY_BIN;
  const env = { ...process.env, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root, APPDATA: root, LOCALAPPDATA: root };
  const firstConf = await configure(first, 'first');
  child = spawn(caddy, ['run', '--adapter', 'caddyfile', '--config', firstConf], { env, cwd: root, windowsHide: true });
  stopped = once(child, 'exit');
  let logs = '';
  child.stderr.on('data', value => { logs += value; });
  function open(hostname, address, pathname) {
    return new Promise((resolve, reject) => {
      const req = https.get({ host: address, port: publicPort, servername: hostname, ca, path: pathname, agent: false,
        headers: { Host: hostname + ':' + publicPort } }, resolve);
      req.on('error', reject);
    });
  }
  async function read(hostname, address, pathname) {
    const res = await open(hostname, address, pathname);
    assert.equal(res.statusCode, 200);
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  }
  for (let n = 0; ; n++) {
    try { await read(first.hostname, '127.0.0.1', '/'); break; }
    catch (error) {
      if (error.code !== 'ECONNREFUSED' || n >= 80 || child.exitCode !== null) assert.fail(error.message + '\n' + logs);
      await new Promise(resolve => setTimeout(resolve, 75));
    }
  }
  event = await open(first.hostname, '::1', '/stream');
  assert.match(String((await once(event, 'data'))[0]), /data: first/);
  const next = await configure(second, 'second');
  const reload = spawnSync(caddy, ['reload', '--address', '127.0.0.1:' + adminPort, '--adapter', 'caddyfile', '--config', next], { env, cwd: root });
  assert.equal(reload.status, 0, reload.stderr?.toString());
  const ongoing = once(event, 'data');
  stream.write('data: still connected\n\n');
  assert.match(String((await ongoing)[0]), /data: still connected/);
  for (const entry of [first, second]) for (const ip of ['127.0.0.1', '::1']) {
    const meta = JSON.parse(await read(entry.hostname, ip, '/.well-known/codecang-relay'));
    assert.deepEqual(meta, { hostId: entry.hostId, relayPort: backend.address().port, hostKey: publicKey(77) });
    assert.equal(await read(entry.hostname, ip, '/'), entry.hostname + ':' + publicPort);
  }
});

test('outer paste, root installer and admin scripts are valid Bash', { skip: !bashAvailable }, () => {
  const body = script.slice(script.indexOf('\n') + 1, script.lastIndexOf('\nCODECANG_RELAY_SETUP'));
  for (const input of [script, body, section('cat > "$base/routes.sh" <<\'ROUTES\'', 'ROUTES'),
    section('cat > "$base/revoke" <<\'REVOKE\'', 'REVOKE')]) {
    const result = spawnSync(bash, ['-n'], { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('actual registry and renderer allocate exclusive durable ports, publish per-device JSON and retire just one key', { skip: !bashAvailable }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codecang-relay-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['devices', 'retired', 'ssh', 'generation']) await mkdir(path.join(root, directory));
  await writeFile(path.join(root, 'host.pub'), publicKey(77) + '\n');
  await writeFile(path.join(root, 'routes.sh'), section('cat > "$base/routes.sh" <<\'ROUTES\'', 'ROUTES'));
  function run(code, args = []) {
    const bootstrap = [
      'set -eu', 'base=.', 'source routes.sh', 'fail(){ echo "$*" >&2; exit 1; }',
      'ss(){ if [[ "$2" == "sport = :49325" ]]; then echo LISTEN; fi; }',
      code,
    ].join('\n');
    return spawnSync(bash, ['-c', bootstrap, 'test', ...args], { cwd: root, encoding: 'utf8' });
  }
  const register = device => run('host=$1; device_key=$2; id=$3; register_device; echo "$assigned"', [device.hostname, device.publicKey, device.hostId]);
  const read = file => readFile(path.join(root, file), 'utf8');
  const render = () => {
    const result = run('render_routes generation');
    assert.equal(result.status, 0, result.stderr);
  };
  function port(device) {
    const result = register(device);
    assert.equal(result.status, 0, result.stderr);
    return Number(result.stdout);
  }
  assert.equal(port(first), 49322);
  assert.equal(port(second), 49324);
  assert.equal(port(first), 49322);
  for (const entry of [
    { ...second, hostId: first.hostId }, { ...second, hostname: first.hostname }, { ...second, publicKey: first.publicKey },
  ]) assert.notEqual(register(entry).status, 0);
  assert.deepEqual((await readdir(path.join(root, 'devices'))).sort(), [first.hostId, second.hostId]);
  render();
  for (const [entry, relayPort] of [[first, 49322], [second, 49324]]) {
    assert.deepEqual(JSON.parse(await read('generation/metadata/' + entry.hostId + '.json')), { hostId: entry.hostId, relayPort, hostKey: publicKey(77) });
    const site = await read('generation/sites/' + entry.hostId + '.caddy');
    assert.ok(site.startsWith(entry.hostname + ' {'));
    assert.match(site, /handle \/\.well-known\/codecang-relay \{/);
    assert.ok(site.includes('reverse_proxy 127.0.0.1:' + relayPort));
    assert.ok((await read('ssh/authorized_keys.new')).includes('restrict,port-forwarding,permitlisten="127.0.0.1:' + relayPort + '" ' + entry.publicKey));
  }
  await rename(path.join(root, 'devices', first.hostId), path.join(root, 'retired', first.hostId));
  assert.notEqual(register(first).status, 0);
  const third = { ...first, hostId: 'c'.repeat(32), hostname: 'three.example.com', publicKey: publicKey(3) };
  assert.equal(port(third), 49326);
  assert.equal(port(second), 49324);
  const after = run('render_routes after');
  assert.equal(after.status, 0, after.stderr);
  assert.equal((await readdir(path.join(root, 'after/sites'))).length, 2);
  assert.equal((await read('ssh/authorized_keys.new')).includes(first.publicKey), false);
  assert.ok((await read('ssh/authorized_keys.new')).includes(second.publicKey));
  await writeFile(path.join(root,'web-entry'),'49168\n');
  const shared=run('render_routes shared; host=$1; write_frontend_examples 49168',[second.hostname]);
  assert.equal(shared.status,0,shared.stderr);
  const inner=await read('shared/Caddyfile'), site=await read('shared/sites/'+second.hostId+'.caddy');
  assert.ok(inner.includes('auto_https off'));assert.ok(inner.includes('http://:49168 {\n    bind 127.0.0.1\n    respond 404'));
  assert.ok(site.startsWith('http://'+second.hostname+':49168 {\n    bind 127.0.0.1'));
  assert.ok(site.includes('reverse_proxy 127.0.0.1:49324'));
  assert.ok((await read('frontends/'+second.hostname+'.caddy')).includes('reverse_proxy 127.0.0.1:49168'));
  const nginx=await read('frontends/'+second.hostname+'.nginx.conf');
  assert.ok(nginx.includes('proxy_set_header Host $host;'));assert.ok(nginx.includes('proxy_buffering off;'));
});
