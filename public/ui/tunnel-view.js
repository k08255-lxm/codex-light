import { createAccessPairing } from './access-pairing-view.js';
import { el } from './format.js';

const TUNNEL_API = '/api/lan/tunnel/';
const DEFAULT_PORT = 49321;
const EXAMPLE_DOMAIN = 'remote.example.com';
const SSH_OFF = { state: 'off', message: '' };
const SSH_LABELS = {
  off: '服务器中继已关闭',
  waiting: '正在等待服务器运行脚本',
  connecting: '正在建立 SSH 中继',
  connected: 'SSH 中继已连接，公网连通性未验证',
  error: '服务器中继连接失败',
};
const GUIDES = {
  frp: {
    url: 'https://gofrp.org/en/docs/examples/vhost-http/',
    text: '让公网反向代理处理 HTTPS，将流量转发到 frps 的 HTTP 虚拟主机端口。反向代理需保留公网 Host，并关闭缓冲以透传实时消息（SSE）。在 frpc.toml 中配置 HTTP 代理。',
  },
  cloudflare: {
    url: 'https://developers.cloudflare.com/tunnel/get-started/',
    text: '在 Cloudflare 命名隧道中添加已发布应用的路由，填入公网主机名，服务类型选择 HTTP，目标填入上面的本机地址。保留公网 Host。临时 Quick Tunnel 缺少实时消息所需的 SSE 支持。',
  },
};

function parseOrigin(value) {
  const input = value.trim();
  if (!/^https:\/\/[\p{L}0-9.-]+(?::[0-9]+)?\/?$/iu.test(input)) return null;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function control(document, label, node) {
  const field = el(document, 'label', 'tunnel-field');
  field.append(el(document, 'span', '', label), node);
  return field;
}

function button(document, label, className = 'btn') {
  const node = el(document, 'button', className, label);
  node.type = 'button';
  return node;
}

export function mountTunnelAccess(host, { api, onIdentity = () => {} }) {
  const document = host.ownerDocument;
  let status = null, active = false, busy = false, readFailed = false;
  let version = 0, reading = null, cancellation = null, poll, pollDelay;
  let providerSelected = false;
  const request = (action, body) => api(TUNNEL_API + action, body);

  const panel = el(document, 'section', 'panel tunnel-panel');
  const heading = el(document, 'h3', '', '公网隧道');
  const intro = el(document, 'p', 'fine', '用自建服务器、frp 或 Cloudflare 命名隧道从外网连接。手机同时使用内网和外网时，需要与同一台电脑分别配对一次。应用重启后需手动开启公网入口。');
  const state = el(document, 'p', 'tunnel-state');
  state.setAttribute('role', 'status');

  const form = el(document, 'form', 'tunnel-form');
  const origin = el(document, 'input');
  origin.id = 'tunnel-public-origin';
  origin.type = 'url';
  origin.placeholder = `https://${EXAMPLE_DOMAIN}`;
  origin.autocomplete = 'off';
  origin.spellcheck = false;
  origin.setAttribute('aria-describedby', 'tunnel-origin-description');
  const port = el(document, 'input');
  port.id = 'tunnel-local-port';
  port.type = 'number';
  port.min = '1';
  port.max = '65535';
  port.step = '1';
  port.value = DEFAULT_PORT;
  const fields = el(document, 'div', 'tunnel-fields');
  fields.append(control(document, '公网 HTTPS 地址', origin), control(document, '本机端口', port));
  const originDescription = el(document, 'p', 'fine', '填写固定公网域名，可带 HTTPS 端口。');
  originDescription.id = 'tunnel-origin-description';
  const enable = button(document, '开启公网入口', 'btn primary');
  enable.type = 'submit';
  const disable = button(document, '关闭公网入口');
  const pair = button(document, '二维码配对', 'btn primary');
  const rotate = button(document, '轮换公网令牌');
  const retry = button(document, '重试读取状态');
  const actions = el(document, 'div', 'work-row');
  actions.append(enable, pair, rotate, disable, retry);
  form.append(fields, originDescription, actions);

  const message = el(document, 'p', 'fine tunnel-message');
  message.setAttribute('role', 'status');
  const say = (text, error = false) => {
    message.textContent = text;
    message.classList.toggle('inline-error', error);
  };
  const pairing = createAccessPairing(document, {
    description: '使用手机相机扫描二维码，或在手机浏览器打开配对链接。两分钟有效，仅可使用一次。',
    copyLink: true,
    say,
    cancel: async () => {
      await cancelPairing(true);
      if (active && !pair.disabled) pair.focus();
    },
  });

  const guide = el(document, 'details', 'tunnel-guide');
  const guideHeading = el(document, 'summary', '', '隧道方案与配置');
  const provider = el(document, 'select');
  provider.id = 'tunnel-provider';
  for (const [value, label] of [['frp', 'frp'], ['cloudflare', 'Cloudflare 命名隧道'], ['ssh', '自建服务器（SSH + Caddy）']]) {
    const option = el(document, 'option', '', label);
    option.value = value;
    provider.append(option);
  }
  const target = el(document, 'code', 'lan-url');
  const guideText = el(document, 'p', 'fine');
  const frpConfig = el(document, 'pre', 'tunnel-frp-config');
  const guideLink = el(document, 'a', 'tunnel-guide-link', '官方配置文档');
  guideLink.target = '_blank';
  guideLink.rel = 'noopener noreferrer';
  const manualGuide = el(document, 'div');
  manualGuide.append(el(document, 'p', 'fine', '本机转发目标'), target, guideText, frpConfig, guideLink);

  const sshGuide = el(document, 'div', 'tunnel-ssh-guide');
  const sshRequirements = el(document, 'p', 'fine', '为每台电脑配置不同的固定子域名。将 DNS A 或 AAAA 记录指向同一台 VPS，也可以用通配 DNS。在 VPS 防火墙放行共用的 TCP 80、443 和 49323 端口。');
  const sshInstall = el(document, 'p', 'fine', '在每台电脑上开启公网入口、复制该电脑的脚本，再到同一台运行 systemd 的 Debian 或 Ubuntu VPS 上以 root 执行。脚本登记这台电脑的 SSH 公钥并分配回源端口，私钥保存在电脑上。');
  const sshOriginHint = el(document, 'p', 'fine');
  const sshState = el(document, 'p', 'tunnel-state');
  sshState.setAttribute('role', 'status');
  const sshMessage = el(document, 'p', 'fine tunnel-ssh-message');
  const sshFeedback = el(document, 'p', 'fine tunnel-ssh-message');
  sshFeedback.setAttribute('role', 'status');
  const sshPrepare = button(document, '复制服务器安装脚本');
  const sshConnect = button(document, '连接已配置的服务器');
  const sshStop = button(document, '停止服务器中继');
  const sshActions = el(document, 'div', 'work-row');
  sshActions.append(sshPrepare, sshConnect, sshStop);
  const sshScript = el(document, 'textarea', 'tunnel-script');
  sshScript.readOnly = true;
  sshScript.rows = 8;
  sshScript.spellcheck = false;
  sshScript.setAttribute('aria-label', '服务器安装脚本');
  sshScript.hidden = true;
  sshGuide.append(sshRequirements, sshInstall, sshOriginHint, sshState, sshMessage, sshActions, sshFeedback, sshScript);
  guide.append(guideHeading, control(document, '隧道服务', provider), manualGuide, sshGuide);

  panel.append(heading, intro, state, form, message, pairing.element, guide);
  host.replaceChildren(panel);

  function selectedPort() {
    const number = Number(port.value);
    return /^\d+$/.test(port.value) && number >= 1 && number <= 65535 ? number : null;
  }

  function renderGuide() {
    const ssh = provider.value === 'ssh';
    const relay = status?.sshRelay || SSH_OFF;
    const relayActive = relay.state !== 'off';
    const sshPort = parseOrigin(origin.value)?.port;
    manualGuide.hidden = ssh;
    sshGuide.hidden = !ssh && !relayActive;
    sshRequirements.hidden = !ssh;
    sshInstall.hidden = !ssh;
    sshOriginHint.hidden = !ssh;
    sshOriginHint.textContent = status?.enabled && sshPort
      ? '请先关闭公网入口，使用标准 HTTPS 端口 443 重新开启，再复制安装脚本。'
      : '自建服务器使用标准 HTTPS 端口 443。';
    sshPrepare.hidden = !ssh;
    sshPrepare.disabled = busy || !status?.enabled || !!sshPort || relay.state === 'connected';
    sshConnect.hidden = !ssh || relayActive;
    sshConnect.disabled = sshPrepare.disabled;
    sshStop.hidden = !relayActive;
    sshStop.disabled = busy;
    const stateLabel = SSH_LABELS[relay.state] || '服务器中继状态未知';
    if (sshState.textContent !== stateLabel) sshState.textContent = stateLabel;
    const detail = relay.message || '';
    if (sshMessage.textContent !== detail) sshMessage.textContent = detail;
    if (ssh) return;

    const cloudflare = provider.value === 'cloudflare';
    const info = cloudflare ? GUIDES.cloudflare : GUIDES.frp;
    const localPort = selectedPort() ?? DEFAULT_PORT;
    const hostname = parseOrigin(origin.value)?.hostname || EXAMPLE_DOMAIN;
    const localTarget = `http://127.0.0.1:${localPort}`;
    if (target.textContent !== localTarget) target.textContent = localTarget;
    if (guideText.textContent !== info.text) guideText.textContent = info.text;
    guideLink.href = info.url;
    frpConfig.hidden = cloudflare;
    const config = [
      '[[proxies]]', 'name = "codecang"', 'type = "http"', 'localIP = "127.0.0.1"',
      `localPort = ${localPort}`, `customDomains = ["${hostname}"]`,
    ].join('\n');
    if (frpConfig.textContent !== config) frpConfig.textContent = config;
  }

  function render() {
    const enabled = !!status?.enabled;
    const label = readFailed ? '暂时无法读取公网入口状态。' : enabled ? '本机入口已就绪，公网连通性未验证。' : status ? '公网入口已关闭' : '正在读取公网入口状态…';
    if (state.textContent !== label) state.textContent = label;
    for (const node of [origin, port]) node.disabled = enabled || busy;
    provider.disabled = busy;
    enable.hidden = enabled;
    enable.disabled = busy || !status || !origin.value.trim();
    for (const node of [pair, rotate, disable]) {
      node.hidden = !enabled;
      node.disabled = busy || !enabled;
    }
    pair.disabled ||= !!cancellation;
    retry.hidden = !readFailed;
    retry.disabled = busy;
    renderGuide();
    if (active) {
      const watchingSsh = ['waiting', 'connecting', 'connected'].includes(status?.sshRelay?.state);
      const delay = watchingSsh ? 3000 : 15000;
      if (pollDelay !== delay) {
        clearInterval(poll);
        pollDelay = delay;
        poll = setInterval(refresh, delay);
      }
    }
  }

  function clearScript() {
    sshScript.value = '';
    sshScript.hidden = true;
    sshFeedback.textContent = '';
  }

  function applyRelay(relay) {
    status = { ...status, sshRelay: relay };
    if (relay.state === 'off' || relay.state === 'connected') clearScript();
  }

  function applyStatus(result) {
    if (!result.enabled || status?.url !== result.url) pairing.clear();
    if (!status && !providerSelected && result.sshRelay?.state && result.sshRelay.state !== 'off') {
      provider.value = 'ssh';
      guide.open = true;
    }
    status = result;
    readFailed = false;
    if (typeof result.remoteHostId === 'string' && /^[a-f0-9]{32}$/i.test(result.remoteHostId)) {
      onIdentity({ id: result.remoteHostId, name: result.remoteHostName });
    }
    if (!result.enabled || result.sshRelay?.state === 'off' || result.sshRelay?.state === 'connected') clearScript();
    if (result.enabled) {
      origin.value = result.origin;
      port.value = result.port;
    }
  }

  async function refresh() {
    if (!active || busy || reading === version) return;
    const mine = version;
    reading = mine;
    try {
      const result = await request('status');
      if (version === mine) applyStatus(result);
    } catch {
      if (version === mine) readFailed = true;
    } finally {
      if (reading === mine) reading = null;
      if (version === mine) render();
    }
  }

  function cancelPairing(reportError = false) {
    if (cancellation) return cancellation;
    const mine = version;
    cancellation = request('cancelPairing', {}).catch(() => {
      if (reportError && version === mine) say('取消配对失败。链接仍可能在有效期内使用。', true);
    }).finally(() => { cancellation = null; render(); });
    render();
    return cancellation;
  }

  async function mutate(action, body, apply) {
    if (!active || busy) return;
    const mine = ++version;
    say('');
    busy = true;
    render();
    try {
      const result = await request(action, body);
      if (version === mine) await apply(result, mine);
      else if (action === 'pairing') await cancelPairing();
    } catch (error) {
      if (version === mine) say(error.message, true);
    } finally {
      busy = false;
      render();
      if (version !== mine || action.startsWith('ssh/')) await refresh();
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (enable.hidden || enable.disabled) return;
    const publicOrigin = parseOrigin(origin.value);
    const localPort = selectedPort();
    if (!publicOrigin) { say('请输入固定的公网 HTTPS 域名地址，例如 https://remote.example.com。', true); origin.focus(); return; }
    if (provider.value === 'ssh' && publicOrigin.port) { say('自建服务器使用标准 HTTPS 端口 443，请填写域名。', true); origin.focus(); return; }
    if (!localPort) { say('本机端口须为 1 至 65535 的整数。', true); port.focus(); return; }
    void mutate('enable', { publicOrigin: origin.value.trim(), port: localPort }, applyStatus);
  });
  disable.addEventListener('click', () => { void mutate('disable', {}, applyStatus); });
  pair.addEventListener('click', () => {
    if (cancellation) return;
    void mutate('pairing', {}, result => pairing.show(result));
  });
  rotate.addEventListener('click', () => {
    void mutate('rotate', {}, result => {
      applyStatus(result);
      say('公网令牌已轮换，旧链接和已配对的公网设备已失效。');
    });
  });
  sshConnect.addEventListener('click', () => {
    clearScript();
    void mutate('ssh/prepare', {}, ({state, message}) => applyRelay({state, message}));
  });
  sshPrepare.addEventListener('click', () => {
    clearScript();
    void mutate('ssh/prepare', {}, async ({ script, state, message }, mine) => {
      applyRelay({ state, message });
      if (typeof script !== 'string' || !script) throw new Error('服务没有返回安装脚本，请重试。');
      try {
        await document.defaultView.navigator.clipboard.writeText(script);
        if (version === mine) sshFeedback.textContent = '脚本已复制。在 VPS 上以 root 执行。';
      } catch {
        if (version !== mine) return;
        sshScript.value = script;
        sshScript.hidden = false;
        sshScript.focus();
        sshScript.select?.();
        sshFeedback.textContent = '无法写入剪贴板，请手动复制下面的脚本。';
      }
    });
  });
  sshStop.addEventListener('click', () => { void mutate('ssh/stop', {}, applyRelay); });
  retry.addEventListener('click', refresh);
  origin.addEventListener('input', render);
  port.addEventListener('input', renderGuide);
  provider.addEventListener('change', () => { providerSelected = true; clearScript(); renderGuide(); });
  render();

  return {
    activate() {
      if (active) return;
      active = true;
      version++;
      say('');
      render();
      return refresh();
    },
    deactivate() {
      if (!active) return;
      active = false;
      version++;
      clearInterval(poll);
      pollDelay = null;
      clearScript();
      if (pairing.clear()) void cancelPairing();
      say('');
    },
  };
}
