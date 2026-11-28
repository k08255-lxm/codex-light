import { execFile, fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import { buildRelayInstaller } from './ssh-relay-script.mjs';

const LEGACY_SSH_PORT = 49323;
const HOST_KEY_PATH = '/.well-known/codecang-relay';
const JSON_LIMIT = 1024;
const ed25519Header = Buffer.from('0000000b7373682d6564323535313900000020', 'hex');
const runKeygen = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);

// ssh -N survives its parent's abrupt death on Windows. A small IPC owner
// closes the actual SSH process on pipe loss, including a desktop crash.
function runSshOwner() {
  if (!process.connected) return;
  const ssh = spawn(openssh('ssh'), process.argv.slice(3), { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });
  let killTimer;
  function terminate() {
    ssh.kill();
    killTimer = setTimeout(() => ssh.kill('SIGKILL'), 1500);
    killTimer.unref();
  }
  process.once('disconnect', terminate);
  ssh.on('error', () => { process.exitCode = 127; });
  ssh.once('close', code => {
    clearTimeout(killTimer);
    process.removeListener('disconnect', terminate);
    if (process.connected) process.disconnect();
    process.exitCode ??= code ?? 1;
  });
}

if (process.argv[1] === modulePath && process.argv[2] === '--own-ssh') runSshOwner();

function openssh(name) {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', `${name}.exe`)
    : `/usr/bin/${name}`;
}

function relayTarget(publicOrigin, port, hostId) {
  let url;
  try { url = new URL(publicOrigin); } catch { throw new TypeError('SSH 中继需要 HTTPS 域名。'); }
  const { hostname, origin } = url;
  const labels = hostname.split('.');
  if (url.protocol !== 'https:' || url.port === '0' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      isIP(hostname) || hostname.length > 253 || labels.length < 2 || labels.at(-1) === 'localhost' ||
      !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new TypeError('SSH 中继需要有效的公网 HTTPS 地址。');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('本机转发端口无效。');
  if (typeof hostId !== 'string' || hostId.length !== 32 || !/^[0-9a-f]+$/.test(hostId)) throw new TypeError('主机标识无效。');
  return { hostname, origin, httpsPort: Number(url.port || 443), port, hostId };
}

function ed25519Key(text) {
  const line = typeof text === 'string' && /^ssh-ed25519 ([A-Za-z0-9+/]{68})(?: [^\x00-\x1f\x7f]*)?\r?\n?$/u.exec(text);
  const wire = line && Buffer.from(line[1], 'base64');
  if (!wire || wire.length !== 51 || !wire.subarray(0, 19).equals(ed25519Header)) {
    throw new Error('SSH 公钥格式无效。');
  }
  return `ssh-ed25519 ${line[1]}`;
}

class RelayResponseError extends Error {}

function readRelayJson(url, { signal, request, body }) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  return new Promise((resolve, reject) => {
    const options = { signal: requestSignal, rejectUnauthorized: true, ca: rootCertificates, agent: false };
    if (body) Object.assign(options, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    const req = request(url, options, response => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new RelayResponseError(`HTTPS 入口返回 HTTP ${response.statusCode}。请检查该站点的中继转发配置。`));
        return;
      }
      if (/^text\/html\b/i.test(response.headers?.['content-type'] || '')) {
        response.destroy();
        reject(new RelayResponseError('HTTPS 地址返回了网页。请检查该域名和端口是否转发到了码舱中继。'));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > JSON_LIMIT) {
          response.destroy();
          reject(new RelayResponseError('HTTPS 入口响应过大。请检查该站点是否转发到了码舱中继。'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('中继响应提前结束。')));
      response.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new RelayResponseError('HTTPS 入口没有返回中继 JSON 配置。请检查站点转发。')); }
      });
    });
    req.once('error', reject);
    req.end(body);
  });
}

async function privateEntry(file, directory = false) {
  const stat = await lstat(file);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink() ||
      (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    throw new Error('SSH 密钥目录或文件的权限无效。');
  }
  return stat;
}

async function unlinkIfPresent(file) {
  try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Node's POSIX mode bits do not set an NTFS DACL. Secure this dedicated
// directory before ssh-keygen creates any private material beneath it.
const restrictWindowsDirectory = `
$ErrorActionPreference = 'Stop'
$dir = $env:CODECANG_RELAY_KEY_DIRECTORY
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$owner = (Get-Acl -LiteralPath $dir).GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $user.Value -and $owner -ne 'S-1-5-32-544') { throw 'Unexpected directory owner' }
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $principal = [Security.Principal.SecurityIdentifier]::new($sid)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($dir, $acl)
`;

async function prepareClientKey(keyDir, keygen, signal) {
  const privateKey = path.join(keyDir, 'id_ed25519');
  await mkdir(keyDir, { mode: 0o700, recursive: true });
  await privateEntry(keyDir, true);
  const options = { signal, windowsHide: true, timeout: 15000, maxBuffer: 4096, encoding: 'utf8' };
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await runKeygen(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', restrictWindowsDirectory], {
      ...options, env: { ...process.env, CODECANG_RELAY_KEY_DIRECTORY: keyDir },
    });
  }
  try { await privateEntry(privateKey); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const stage = await mkdtemp(path.join(keyDir, 'key-'));
    const temporaryKey = path.join(stage, 'id_ed25519');
    try {
      await keygen(openssh('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-C', 'CodeCang SSH relay', '-f', temporaryKey], options);
      await privateEntry(temporaryKey);
      signal.throwIfAborted();
      // Atomically publish a complete key. Concurrent desktop instances reuse the winner.
      try { await link(temporaryKey, privateKey); } catch (linkError) { if (linkError.code !== 'EEXIST') throw linkError; }
    } finally {
      await unlinkIfPresent(temporaryKey + '.pub');
      await unlinkIfPresent(temporaryKey);
      await rmdir(stage);
    }
    await privateEntry(privateKey);
  }
  const { stdout } = await keygen(openssh('ssh-keygen'), ['-y', '-f', privateKey], options);
  return { privateKey, publicKey: ed25519Key(stdout) };
}

function sshConfigPath(file) {
  const pathname = process.platform === 'win32' ? file.replace(/\\/g, '/') : file;
  return `"${pathname.replace(/%/g, '%%').replace(/[\\"]/g, '\\$&')}"`;
}

function sshArguments({ hostname, port, relayPort, sshPort }, privateKey, knownHosts) {
  const settings = [
    'BatchMode=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'CertificateFile=none',
    `IdentityFile=${sshConfigPath(privateKey)}`, 'PreferredAuthentications=publickey',
    'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'GSSAPIAuthentication=no',
    'HostbasedAuthentication=no', 'StrictHostKeyChecking=yes', 'HostKeyAlgorithms=ssh-ed25519',
    `UserKnownHostsFile=${sshConfigPath(knownHosts)}`, 'GlobalKnownHostsFile=none', 'KnownHostsCommand=none',
    'UpdateHostKeys=no', 'VerifyHostKeyDNS=no', 'ExitOnForwardFailure=yes', 'ForwardAgent=no', 'ForwardX11=no',
    'PermitLocalCommand=no', 'ProxyCommand=none', 'ProxyJump=none', 'ControlMaster=no', 'ControlPath=none',
    'StdinNull=yes', 'EscapeChar=none', 'PermitRemoteOpen=none', 'ConnectTimeout=8', 'ConnectionAttempts=1',
    'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'LogLevel=ERROR', 'LogVerbose=*ssh_confirm_remote_forward():*',
  ];
  return ['-F', 'none', '-N', '-T', ...settings.flatMap(option => ['-o', option]), '-p', String(sshPort),
    '-R', `127.0.0.1:${relayPort}:127.0.0.1:${port}`, `codecang-tunnel@${hostname}`];
}

async function forwardConnection(spawnProcess, target, privateKey, knownHosts, { signal, timeout, prove, onReady }) {
  signal.throwIfAborted();
  const args = sshArguments(target, privateKey, knownHosts);
  const options = { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' } };
  const child = spawnProcess ? spawnProcess(openssh('ssh'), args, options)
    : fork(modulePath, ['--own-ssh', ...args], { ...options, stdio: [...options.stdio, 'ipc'], execArgv: [] });
  const lifetime = new AbortController();
  const proofSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(timeout)]);
  let launchError, killTimer, ready = false, confirmed = false;
  function terminate() {
    if (lifetime.signal.aborted || killTimer) return;
    if (!spawnProcess) {
      if (child.connected) child.disconnect();
      return;
    }
    child.kill();
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
    killTimer.unref();
  }
  const closed = new Promise(resolve => {
    function finished(code) {
      if (code === 127) launchError = true;
      lifetime.abort();
      resolve();
    }
    child.on('error', error => {
      launchError = error;
      if (!child.pid) finished();
    });
    // Windows fork() can emit exit without close after explicit IPC disconnect.
    // The owner itself exits only after its native ssh process is reaped.
    child.once('exit', finished);
    child.once('close', finished);
  });
  signal.addEventListener('abort', terminate, { once: true });
  const diagnostics = createInterface({ input: child.stderr });
  const expected = `remote forward success for: listen 127.0.0.1:${target.relayPort}, connect 127.0.0.1:${target.port}`;
  try {
    // LogLevel=ERROR suppresses server auth banners. Only the selected OpenSSH
    // callback emits the verbose diagnostic with this exact forwarding tuple.
    confirmed = await new Promise(resolve => {
      const cancel = () => resolve(false);
      proofSignal.addEventListener('abort', cancel, { once: true });
      diagnostics.on('line', line => {
        if (/^debug1: [^\r\n]*ssh\.c:ssh_confirm_remote_forward\(\):\d+ \(pid=\d+\): /.test(line) && line.endsWith(': ' + expected)) {
          proofSignal.removeEventListener('abort', cancel);
          resolve(true);
        }
      });
      if (proofSignal.aborted) cancel();
    });
    // A fresh HTTPS challenge traverses the public origin, reverse forward and this
    // restricted listener. SSH banners, stale forwards and proxies cannot attest it.
    while (confirmed && !proofSignal.aborted) {
      if (await prove(proofSignal) && !proofSignal.aborted) {
        ready = true;
        onReady();
        break;
      }
      await pause(500, undefined, { signal: proofSignal }).catch(() => {});
    }
  } finally {
    if (!ready) terminate();
    await closed;
    diagnostics.close();
    clearTimeout(killTimer);
    signal.removeEventListener('abort', terminate);
  }
  return { ready, launchError, confirmed };
}

export class SshRelay {
  #keyDir;
  #readJson;
  #spawn;
  #keygen;
  #retry;
  #session;
  #task = Promise.resolve();
  #closed = false;
  #status = { state: 'off', message: 'SSH 中继未连接。' };

  constructor({ keyDir, request = httpsRequest, spawnProcess, keygen = runKeygen, retryDelayMs = 4000,
    maxAttempts = 50, waitTimeoutMs = 180000, connectTimeoutMs = 12000 } = {}) {
    if (typeof keyDir !== 'string' || !path.isAbsolute(keyDir) || /[\x00-\x1f]|\$\{/u.test(keyDir)) {
      throw new TypeError('SSH 密钥目录必须是用户专属的本机绝对路径。');
    }
    this.#keyDir = path.resolve(keyDir);
    this.#readJson = (url, signal, body) => readRelayJson(url, { signal, request, body });
    this.#spawn = spawnProcess;
    this.#keygen = keygen;
    this.#retry = { retryDelayMs, maxAttempts, waitTimeoutMs, connectTimeoutMs };
  }

  get status() { return { ...this.#status }; }

  #update(session, state, message) {
    if (this.#session === session && !session.signal.aborted) this.#status = { state, message };
  }

  async #credentials(target, signal, randomPorts = false) {
    signal.throwIfAborted();
    const key = await prepareClientKey(this.#keyDir, this.#keygen, signal);
    signal.throwIfAborted();
    const installer = buildRelayInstaller({...target, publicKey:key.publicKey, randomPorts});
    return {installer, privateKey:key.privateKey};
  }

  async installer({publicOrigin, port, hostId, randomPorts = false}) {
    if(this.#closed)throw new Error('SSH 中继控制器已关闭。');
    const {installer}=await this.#credentials(relayTarget(publicOrigin,port,hostId),AbortSignal.timeout(15000),randomPorts);
    return {...installer,...this.status};
  }

  async prepare({ publicOrigin, port, hostId, verifyRelayProof }) {
    if (this.#closed) throw new Error('SSH 中继控制器已关闭。');
    const target = relayTarget(publicOrigin, port, hostId);
    if (typeof verifyRelayProof !== 'function') throw new TypeError('缺少本机入口验证器。');
    let session = this.#session;
    if (!session || session.target.origin !== target.origin || session.target.port !== target.port || session.target.hostId !== hostId || this.#status.state === 'error') {
      session?.controller.abort();
      const controller = new AbortController();
      const signal = controller.signal;
      session = { target, controller, signal, verifyRelayProof };
      this.#session = session;
      this.#update(session, 'waiting', '正在准备 SSH 中继密钥。');
      session.prepared = this.#task.then(() => this.#credentials(target,signal));
      const active = session;
      this.#task = session.prepared.then(({ privateKey }) => this.#connect(active, privateKey), error => {
        active.prepareError = error.code === 'ENOENT' ? '未找到 Windows OpenSSH 客户端或其密钥工具。' : '无法创建或读取 SSH 中继专用密钥。';
        this.#update(active, 'error', active.prepareError);
      }).catch(() => this.#update(active, 'error', 'SSH 中继连接或清理失败。'));
    }
    try {
      const { installer } = await session.prepared;
      session.signal.throwIfAborted();
      return { ...installer, ...this.status };
    } catch (cause) {
      if (session.signal.aborted) throw new Error('SSH 中继准备已取消。');
      throw new Error(session.prepareError || '无法创建 SSH 中继安装脚本。', { cause });
    }
  }

  async #connect(session, privateKey) {
    const { target, signal } = session;
    if (signal.aborted) return;
    const { retryDelayMs, maxAttempts, waitTimeoutMs, connectTimeoutMs } = this.#retry;
    const deadline = Date.now() + waitTimeoutMs;
    const pinDirectory = await mkdtemp(path.join(this.#keyDir, 'connection-'));
    const knownHosts = path.join(pinDirectory, 'known_hosts');
    const keyUrl = new URL(HOST_KEY_PATH, target.origin);
    let reconnectDeadline;
    let remaining = maxAttempts;
    let failure;
    try {
      while (!signal.aborted && remaining-- > 0 && Date.now() < (reconnectDeadline ?? deadline)) {
        if (!failure) this.#update(session, 'waiting', '正在通过公网 HTTPS 读取服务器的中继配置。');
        let hostKey, relayPort, sshPort;
        try {
          const metadata = await this.#readJson(keyUrl, signal);
          if (!metadata?.hostId) throw new RelayResponseError('HTTPS 入口缺少码舱中继配置。请检查域名和端口的转发规则。');
          if (metadata.hostId !== target.hostId) throw new RelayResponseError('该地址注册的是另一台电脑。请核对公网地址和安装命令。');
          relayPort = metadata.relayPort;
          sshPort = metadata.sshPort === undefined ? LEGACY_SSH_PORT : metadata.sshPort;
          if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535 || sshPort === target.httpsPort ||
              !Number.isInteger(relayPort) || relayPort < 49322 || relayPort > 49999 || relayPort === sshPort || relayPort === LEGACY_SSH_PORT) {
            throw new RelayResponseError('服务器返回的中继端口无效。请核对服务器安装配置。');
          }
          hostKey = ed25519Key(metadata.hostKey);
        }
        catch (error) {
          if (error instanceof RelayResponseError) failure = error.message;
          else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') failure = '无法解析中继域名。请检查 DNS。';
          else if (error.code === 'ABORT_ERR' || error.code === 'ETIMEDOUT') failure = '读取公网 HTTPS 配置超时。请检查端口和防火墙。';
          else if (error.code === 'ECONNREFUSED') failure = '公网 HTTPS 端口拒绝连接。请检查该端口是否已启动监听。';
          else if (/CERT|SELF_SIGNED|VERIFY_LEAF/i.test(error.code || '')) failure = '公网 HTTPS 证书验证失败。请核对域名和证书链。';
          else failure = '读取公网 HTTPS 中继配置失败。请检查域名、证书及服务器配置。';
        }
        if (hostKey && !signal.aborted) {
          await writeFile(knownHosts, `[${target.hostname}]:${sshPort} ${hostKey}\n`, { mode: 0o600, signal });
          this.#update(session, 'connecting', `正在连接 SSH 端口 ${sshPort} 并验证公网回源。`);
          const result = await forwardConnection(this.#spawn, { ...target, relayPort, sshPort }, privateKey, knownHosts, { signal, timeout: connectTimeoutMs,
            prove: async proofSignal => {
              const nonce = randomBytes(16).toString('hex');
              try {
                const { proof } = await this.#readJson(new URL('/api/pairing/prove', target.origin), proofSignal, JSON.stringify({ nonce }));
                return typeof proof === 'string' && proof.length === 64 && /^[0-9a-f]+$/.test(proof) && session.verifyRelayProof(nonce, proof) === true;
              } catch { return false; }
            },
            onReady: () => this.#update(session, 'connected', 'SSH 反向转发已建立。'),
          });
          if (result.launchError) {
            this.#update(session, 'error', '无法启动 OpenSSH 客户端。');
            return;
          }
          failure = result.ready ? 'SSH 连接已断开。' : result.confirmed ? 'SSH 转发已建立，但公网 HTTPS 未能验证到这台电脑。请检查代理转发的 Host 和端口。'
            : `SSH 端口 ${sshPort} 未能建立转发。请检查端口放行和服务器注册。`;
          if (result.ready) {
            reconnectDeadline = Date.now() + 30000;
            remaining = Math.min(maxAttempts, 3);
          }
        }
        if (!signal.aborted && remaining > 0) {
          this.#update(session, 'retrying', failure);
          await pause(retryDelayMs, undefined, { signal });
        }
      }
      this.#update(session, 'error', failure || '等待 SSH 中继连接超时。');
    } finally {
      await unlinkIfPresent(knownHosts);
      await rmdir(pinDirectory);
    }
  }

  async stop() {
    const session = this.#session;
    this.#session = null;
    this.#status = { state: 'off', message: 'SSH 中继未连接。' };
    session?.controller.abort();
    await this.#task;
    return this.status;
  }

  async close() {
    this.#closed = true;
    return this.stop();
  }
}
