import { createAccessPairing } from './access-pairing-view.js';
import { el, switchInput, onAsyncSwitchChange } from './format.js';

const TUNNEL_API = '/api/lan/tunnel/';
const DEFAULT_PORT = 49321;
const EXAMPLE_DOMAIN = 'remote.example.com';
const SSH_OFF = { state: 'off', message: '' };
const SSH_LABELS = {
  off: '服务器中继已关闭',
  waiting: '正在等待服务器运行脚本',
  connecting: '正在建立 SSH 中继',
  connected: 'SSH 中继已连接',
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
  const text = value.trim();
  const input = text.includes('://') ? text : 'https://'+text;
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
  let providerSelected = false, configuring = false, installerUrl = null;
  const request = (action, body) => api(TUNNEL_API + action, body);

  const panel = el(document, 'section', 'panel tunnel-panel');
  const heading = el(document, 'h3', '', '公网访问');
  const intro = el(document, 'p', 'fine access-description', '离开本地网络后，通过固定的 HTTPS 域名连接此电脑。');
  const state = el(document, 'p', 'tunnel-state');
  state.setAttribute('role', 'status');
  const header=el(document,'div','access-heading'), title=el(document,'div');
  const configure=button(document,'配置公网访问');
  const toggle=switchInput(document);toggle.setAttribute('aria-label','公网访问');
  configure.setAttribute('aria-controls','tunnel-configuration');
  title.append(heading,state);header.append(title,toggle);
  const setup=el(document,'div','tunnel-configuration');setup.id='tunnel-configuration';

  const form = el(document, 'form', 'tunnel-form');
  const origin = el(document, 'input');
  origin.id = 'tunnel-public-origin';
  origin.type = 'text';origin.inputMode='url';origin.autocapitalize='none';origin.required=true;
  origin.placeholder = EXAMPLE_DOMAIN;
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
  const originDescription = el(document, 'p', 'fine', '填写指向公网入口的域名。');
  originDescription.id = 'tunnel-origin-description';
  const enable = button(document, '开启公网入口', 'btn primary');
  enable.type = 'submit';
  const disable = button(document, '关闭公网入口');
  const pair = button(document, '二维码配对', 'btn primary');
  const rotate = button(document, '轮换公网令牌');
  const retry = button(document, '重试读取状态');
  const actions = el(document, 'div', 'work-row');
  const options=el(document,'details','access-options'), advancedActions=el(document,'div','work-row');
  advancedActions.append(rotate,disable);
  options.append(el(document,'summary','','端口与访问管理'),control(document,'本机端口',port),advancedActions);
  actions.append(enable);
  form.append(fields,originDescription,actions);
  const quickActions=el(document,'div','work-row access-quick');quickActions.append(pair,configure,retry);

  const message = el(document, 'p', 'fine tunnel-message');
  message.id='tunnel-feedback';
  origin.setAttribute('aria-describedby','tunnel-origin-description tunnel-feedback');
  port.setAttribute('aria-describedby','tunnel-feedback');
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
  const guideHeading = el(document, 'summary', '', '服务接入说明');
  const provider = el(document, 'select');
  provider.id = 'tunnel-provider';
  for (const [value, label] of [['ssh', '自己的 Linux 服务器'], ['cloudflare', 'Cloudflare Tunnel'], ['frp', '已有 frp 隧道']]) {
    const option = el(document, 'option', '', label);
    option.value = value;
    provider.append(option);
  }
  fields.append(control(document,'连接方式',provider),control(document,'公网域名',origin));
  try { const stored=document.defaultView.localStorage?.getItem('codecang.tunnelProvider');if(['ssh','cloudflare','frp'].includes(stored)){provider.value=stored;providerSelected=true;} } catch {}
  const target = el(document, 'code', 'lan-url');
  const guideText = el(document, 'p', 'fine');
  const frpConfig = el(document, 'pre', 'tunnel-frp-config');
  const guideLink = el(document, 'a', 'tunnel-guide-link', '官方配置文档');
  guideLink.target = '_blank';
  guideLink.rel = 'noopener noreferrer';
  const manualGuide = el(document, 'div');
  manualGuide.append(el(document, 'p', 'fine', '本机转发目标'), target, guideText, frpConfig, guideLink);

  const sshGuide = el(document, 'div', 'tunnel-ssh-guide');
  const sshRequirements = el(document, 'p', 'fine', '将这台电脑的子域名指向 Debian 或 Ubuntu 服务器，开放 SSH 中继端口 49323。');
  const sshInstall = el(document, 'p', 'fine', '已有 Caddy 或 Nginx 时，安装程序会生成接入配置。空闲服务器可由码舱提供 HTTPS。');
  const sshOriginHint = el(document, 'p', 'fine');
  const sshState = el(document, 'p', 'tunnel-state');
  sshState.setAttribute('role', 'status');
  const sshMessage = el(document, 'p', 'fine tunnel-ssh-message');
  const sshFeedback = el(document, 'p', 'fine tunnel-ssh-message');
  sshFeedback.setAttribute('role', 'status');
  const sshPrepare = button(document, '获取安装命令','btn primary');
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
  const installer=el(document,'div','relay-installer');installer.hidden=true;
  const installHint=el(document,'p','fine');
  const command=el(document,'input','relay-command');command.readOnly=true;command.setAttribute('aria-label','服务器安装命令');
  const copyCommand=button(document,'复制安装命令','btn primary');
  const download=el(document,'a','btn','下载脚本');download.download='codecang-relay-setup.sh';
  const source=el(document,'details','access-options');source.append(el(document,'summary','','查看脚本'),sshScript);
  const installActions=el(document,'div','work-row');installActions.append(copyCommand,download);
  installer.append(installHint,command,installActions,source);
  sshGuide.append(sshState,sshMessage,sshActions,installer,sshFeedback);
  guide.append(guideHeading,sshRequirements,sshInstall,sshOriginHint,manualGuide);
  setup.append(form,sshGuide,guide,options);
  panel.append(header,intro,quickActions,pairing.element,setup,message);
  configure.addEventListener('click',()=>{configuring=!configuring;render();if(configuring&&!status?.enabled)origin.focus();});
  copyCommand.addEventListener('click',async()=>{
    const mine=version;
    try{await document.defaultView.navigator.clipboard.writeText(command.value);if(version===mine)sshFeedback.textContent='安装命令已复制。';}
    catch{if(version===mine){command.focus();command.select?.();sshFeedback.textContent='请手动复制选中的安装命令。';}}
  });
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
    sshGuide.hidden = !status?.enabled || (!ssh && !relayActive);
    sshRequirements.hidden = !ssh;
    sshInstall.hidden = !ssh;
    sshOriginHint.hidden = !ssh;
    sshOriginHint.textContent = sshPort ? '自建服务器的公网 HTTPS 地址使用 443 端口。' : '';
    sshPrepare.hidden = !ssh || !installer.hidden;
    sshPrepare.disabled = busy || !status?.enabled || !!sshPort || relay.state === 'connected';
    sshConnect.hidden = !ssh || (relayActive && relay.state!=='error');
    sshConnect.textContent=relay.state==='error'?'重新连接服务器':'连接已配置的服务器';
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
    toggle.checked=enabled;toggle.disabled=!status||busy;
    setup.hidden=!configuring;
    configure.setAttribute('aria-expanded',String(configuring));
    configure.textContent=configuring?'收起配置':enabled?'管理公网访问':'配置公网访问';
    const label = readFailed ? '暂时无法读取公网入口状态。' : enabled && status.sshRelay?.state==='connected' ? '已连接 · 公网回源已验证' : enabled ? '本机入口已就绪，公网连通性未验证。' : status ? '公网入口已关闭' : '正在读取公网入口状态…';
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
    if(installerUrl)URL.revokeObjectURL(installerUrl);
    installerUrl=null;download.removeAttribute('href');installer.hidden=true;command.value='';source.open=false;
    sshScript.value = '';
    sshScript.hidden = true;
    sshFeedback.textContent = '';
  }

  function applyRelay(relay) {
    status = { ...status, sshRelay: relay };
    if (relay.state === 'off' || relay.state === 'connected') clearScript();
  }

  function applyStatus(result) {
    if (!result.enabled || status?.url !== result.url) {pairing.clear();clearScript();}
    if (!status && !providerSelected && result.sshRelay?.state && result.sshRelay.state !== 'off') {
      provider.value = 'ssh';
      configuring=true;
      guide.open = true;
    }
    status = result;
    readFailed = false;
    if (typeof result.remoteHostId === 'string' && /^[a-f0-9]{32}$/i.test(result.remoteHostId)) {
      onIdentity({ id: result.remoteHostId, name: result.remoteHostName });
    }
    if (result.sshRelay?.state === 'connected') clearScript();
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

  function enablePublic() {
    if (enable.hidden || enable.disabled) return;
    const publicOrigin = parseOrigin(origin.value);
    const localPort = selectedPort();
    if (!publicOrigin) { origin.setAttribute('aria-invalid','true');say('请输入固定公网域名，例如 remote.example.com。', true); origin.focus(); return; }
    if (provider.value === 'ssh' && publicOrigin.port) { origin.setAttribute('aria-invalid','true');say('自建服务器使用标准 HTTPS 端口 443，请填写域名。', true); origin.focus(); return; }
    if (!localPort) { options.open=true;port.setAttribute('aria-invalid','true');say('本机端口须为 1 至 65535 的整数。', true); port.focus(); return; }
    origin.removeAttribute('aria-invalid');
    return mutate('enable', { publicOrigin: publicOrigin.origin, port: localPort }, applyStatus);
  }
  form.addEventListener('submit',event=>{event.preventDefault();void enablePublic();});
  onAsyncSwitchChange(toggle,async()=>{
    const wanted=toggle.checked;toggle.checked=!!status?.enabled;
    if(!status||busy)return;
    if(!wanted){await mutate('disable',{},applyStatus);return;}
    configuring=true;render();
    if(!origin.value.trim()){origin.focus();return;}
    await enablePublic();
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
    void mutate('ssh/installer', {}, ({script,command:installCommand,online,state,message}) => {
      applyRelay({ state, message });
      if(!script || !installCommand)throw new Error('没有收到服务器安装文件，请重试。');
      clearScript();installer.hidden=false;command.value=installCommand;sshScript.value=script;sshScript.hidden=false;
      installerUrl=URL.createObjectURL(new Blob(['#!/usr/bin/env bash\n',script],{type:'text/x-shellscript;charset=utf-8'}));download.href=installerUrl;
      copyCommand.classList.toggle('primary',online);download.classList.toggle('primary',!online);
      installActions.replaceChildren(...(online?[copyCommand,download]:[download,copyCommand]));
      installHint.textContent=online?'在服务器以 root 身份执行，命令会先校验脚本的 SHA-256。完成后点击「连接已配置的服务器」。':'当前无法验证在线脚本。下载脚本并上传到服务器，在文件所在目录以 root 身份执行下面的命令，完成后点击「连接已配置的服务器」。';
    });
  });
  sshStop.addEventListener('click', () => { void mutate('ssh/stop', {}, applyRelay); });
  retry.addEventListener('click', refresh);
  origin.addEventListener('input', ()=>{origin.removeAttribute('aria-invalid');render();});
  port.addEventListener('input', ()=>{port.removeAttribute('aria-invalid');renderGuide();});
  provider.addEventListener('change', () => { providerSelected=true; try{document.defaultView.localStorage?.setItem('codecang.tunnelProvider',provider.value);}catch{} clearScript();renderGuide(); });
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
