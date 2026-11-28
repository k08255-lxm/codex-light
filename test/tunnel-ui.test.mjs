import test from 'node:test';
import assert from 'node:assert/strict';
import { mountLanAccess } from '../public/ui/lan-view.js';
import { createDocument } from './mini-dom.mjs';

const sameOrigin = 'https://remote.example.test:9443';
const ticket = `${sameOrigin}/#pair=${'a'.repeat(64)}`;
const tunnelEnabled = {
  enabled: true, address: '127.0.0.1', port: 49322, origin: sameOrigin, url: `${sameOrigin}/#token=${'b'.repeat(64)}`,
};
const wifi = { address: '192.168.1.9', name: 'Wi-Fi' };
const vpn = { address: '10.0.0.9', name: 'VPN' };
const settled = () => new Promise(resolve => setImmediate(resolve));
const button = (parent, label) => parent.querySelectorAll('button').find(node => node.textContent === label);

function fixture(t, overrides = {}) {
  const document = createDocument();
  const create = document.createElement;
  document.createElement = tag => {
    const node = create(tag);
    if (tag === 'canvas') node.getContext = () => ({ fillRect() {} });
    if (tag === 'dialog') {
      node.showModal = () => { node.open = true; };
      node.close = () => { node.open = false; node.dispatch('close'); };
    }
    return node;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const calls = [];
  const mocks = {
    '/api/lan/status': () => ({ enabled: false, addresses: [wifi, vpn] }),
    '/api/lan/cancelPairing': () => ({ cancelled: true }),
    '/api/lan/tunnel/status': () => ({ enabled: false }),
    '/api/lan/tunnel/enable': () => tunnelEnabled,
    '/api/lan/tunnel/disable': () => ({ enabled: false }),
    '/api/lan/tunnel/rotate': () => ({ ...tunnelEnabled, url: `${sameOrigin}/#token=${'c'.repeat(64)}` }),
    '/api/lan/tunnel/pairing': () => ({ url: ticket, expiresAt: Date.now() + 120000 }),
    '/api/lan/tunnel/cancelPairing': () => ({ cancelled: true }),
    ...overrides,
  };
  const view = mountLanAccess(host, { api: async (path, body) => {
    calls.push({ path, body });
    return mocks[path](body);
  } });
  t.after(() => view.deactivate());
  return { document, host, view, calls, panel: host.querySelector('.tunnel-panel') };
}

test('the separate public access form enables with explicit settings and reports only local readiness', async t => {
  const { view, panel, calls } = fixture(t);
  await view.activate();
  const origin = panel.querySelector('#tunnel-public-origin'), port = panel.querySelector('#tunnel-local-port');
  const form = panel.querySelector('form');
  button(panel,'配置公网访问').click();
  const provider=panel.querySelector('#tunnel-provider');provider.value='frp';provider.dispatch('change');
  assert.match(panel.querySelector('.tunnel-state').textContent, /已关闭/);
  assert.equal(port.value, '49321');
  assert.equal(button(panel, '开启公网入口').disabled, true);
  origin.value = `${sameOrigin}/path`;
  origin.dispatch('input');
  form.dispatch('submit');
  assert.match(panel.querySelector('.tunnel-message').textContent, /固定公网域名/);
  origin.value = sameOrigin;
  port.value = 65536;
  form.dispatch('submit');
  assert.match(panel.querySelector('.tunnel-message').textContent, /65535/);
  assert.ok(!calls.some(call => call.path.endsWith('/enable')));
  port.value = 49322;
  form.dispatch('submit');
  await settled();
  assert.deepEqual(calls.filter(call => call.path.endsWith('/enable')), [
    { path: '/api/lan/tunnel/enable', body: { publicOrigin: sameOrigin, port: 49322 } },
  ]);
  assert.match(panel.querySelector('.tunnel-state').textContent, /本机入口已就绪，公网连通性未验证/);
  assert.equal(origin.disabled, true);
  assert.equal(port.disabled, true);
  assert.ok(!panel.textContent.includes(tunnelEnabled.url));
  button(panel, '关闭公网入口').click();
  await settled();
  assert.deepEqual(calls.at(-1), { path: '/api/lan/tunnel/disable', body: {} });
  assert.match(panel.querySelector('.tunnel-state').textContent, /已关闭/);
  assert.equal(origin.disabled, false);
});

test('the provider selector updates configuration guidance without calling a provider', async t => {
  const { view, panel, calls } = fixture(t);
  await view.activate();
  const guide = panel.querySelector('.tunnel-guide');
  const provider = panel.querySelector('#tunnel-provider'), config = guide.querySelector('pre'), link = guide.querySelector('a');
  provider.value='frp';provider.dispatch('change');
  const origin = panel.querySelector('#tunnel-public-origin'), port = panel.querySelector('#tunnel-local-port');
  origin.value = sameOrigin;
  origin.dispatch('input');
  port.value = '48332';
  port.dispatch('input');
  assert.match(config.textContent, /localPort = 48332/);
  assert.match(config.textContent, /customDomains = \["remote\.example\.test"\]/);
  assert.equal(link.href, 'https://gofrp.org/en/docs/examples/vhost-http/');
  provider.value = 'cloudflare';
  provider.dispatch('change');
  assert.equal(guide.querySelector('code').textContent, 'http://127.0.0.1:48332');
  assert.equal(config.hidden, true);
  assert.match(guide.textContent, /命名隧道.*Quick Tunnel.*SSE/);
  assert.equal(link.href, 'https://developers.cloudflare.com/tunnel/get-started/');
  assert.deepEqual(calls.map(call => call.path).sort(), ['/api/lan/status', '/api/lan/tunnel/status']);
});

test('public pairing copies a one-time link and cancellation and rotation use only public endpoints', async t => {
  const { document, view, panel, calls } = fixture(t, { '/api/lan/tunnel/status': () => tunnelEnabled });
  const clipboard = [];
  document.defaultView.navigator.clipboard = { writeText: async value => { clipboard.push(value); } };
  await view.activate();
  button(panel, '二维码配对').click();
  await settled();
  assert.ok(panel.querySelector('canvas').width > 0);
  button(panel, '复制配对链接').click();
  await settled();
  assert.deepEqual(clipboard, [ticket]);
  assert.ok(!panel.textContent.includes(ticket));
  button(panel, '取消配对').click();
  await settled();
  assert.equal(panel.querySelector('canvas'), null);
  assert.deepEqual(calls.at(-1), { path: '/api/lan/tunnel/cancelPairing', body: {} });
  button(panel, '二维码配对').click();
  await settled();
  button(panel, '轮换公网令牌').click();
  await settled();
  assert.equal(panel.querySelector('canvas'), null);
  assert.deepEqual(calls.at(-1), { path: '/api/lan/tunnel/rotate', body: {} });
  assert.match(panel.querySelector('.tunnel-message').textContent, /旧链接和已配对的公网设备已失效/);
  assert.ok(!calls.some(call => /^\/api\/lan\/(pairing|rotate|cancelPairing)$/.test(call.path)));
});

test('leaving settings during a pending public pairing cancels the eventual ticket', async t => {
  const pending = Promise.withResolvers();
  const { view, panel, calls } = fixture(t, {
    '/api/lan/tunnel/pairing': () => pending.promise,
    '/api/lan/tunnel/status': () => tunnelEnabled,
  });
  await view.activate();
  button(panel, '二维码配对').click();
  view.deactivate();
  const ready = view.activate();
  pending.resolve({ url: ticket, expiresAt: Date.now() + 120000 });
  await ready;
  await settled();
  assert.equal(panel.querySelector('canvas'), null);
  assert.equal(calls.filter(call => call.path === '/api/lan/tunnel/cancelPairing').length, 1);
  assert.equal(button(panel, '二维码配对').disabled, false);
});

test('LAN polling follows the default order until a user selects another address and uses a running address', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let lan = { enabled: false, addresses: [vpn] };
  const { host, view } = fixture(t, { '/api/lan/status': () => lan });
  await view.activate();
  const select = host.querySelector('.lan-panel').querySelector('select');
  assert.equal(select.value, vpn.address);
  lan = { enabled: false, addresses: [wifi, vpn] };
  t.mock.timers.tick(15000);
  await settled();
  assert.equal(select.value, wifi.address);
  select.value = vpn.address;
  select.dispatch('change');
  t.mock.timers.tick(15000);
  await settled();
  assert.equal(select.value, vpn.address);
  lan = { ...lan, enabled: true, address: wifi.address };
  t.mock.timers.tick(15000);
  await settled();
  assert.equal(select.value, wifi.address);
  assert.equal(select.disabled, true);
});

const modernLan = {
  enabled: false, addresses: [wifi, vpn], mode: null, endpoints: [],
  persistent: false, persistenceAvailable: true,
};
const lanEndpoints = [wifi, vpn].map(({ address }) => {
  const origin = `http://${address}:49340`;
  return { address, origin, url: `${origin}/#token=${'d'.repeat(64)}` };
});

test('all adapters are the default and each active LAN address has its own link and QR', async t => {
  const { document, host, view, calls } = fixture(t, {
    '/api/lan/status': () => modernLan,
    '/api/lan/enable': () => ({ ...modernLan, enabled: true, mode: 'auto', endpoints: lanEndpoints }),
    '/api/lan/pairing': ({ address }) => ({
      url: `http://${address}:49340/#pair=${'a'.repeat(64)}`, expiresAt: Date.now() + 120000,
    }),
  });
  const copied = [];
  document.defaultView.navigator.clipboard = { writeText: async value => copied.push(value) };
  await view.activate();
  const panel = host.querySelector('.lan-panel'), toggle = panel.querySelector('input'), select = panel.querySelector('select');
  assert.equal(select.value, 'auto');
  assert.deepEqual(select.options.map(node => node.value), ['auto', wifi.address, vpn.address]);
  toggle.checked = true;
  toggle.dispatch('change');
  await settled();
  assert.deepEqual(calls.at(-1), { path: '/api/lan/enable', body: { address: 'auto', port: 0, persistent: false } });
  assert.equal(document.querySelector('dialog'), null);
  assert.equal(select.value, wifi.address);
  assert.equal(select.disabled, false);
  for (const endpoint of lanEndpoints) {
    select.value = endpoint.address;
    select.dispatch('change');
    await settled();
    assert.ok(!panel.querySelector('.lan-url').textContent.includes(endpoint.url));
    button(panel, '显示链接').click();
    assert.equal(panel.querySelector('.lan-url').textContent, endpoint.url);
    button(panel, '复制链接').click();
    button(panel, '二维码配对').click();
    await settled();
    assert.deepEqual(calls.at(-1), { path: '/api/lan/pairing', body: { address: endpoint.address } });
    assert.ok(panel.querySelector('canvas'));
  }
  assert.deepEqual(copied, lanEndpoints.map(endpoint => endpoint.url));
  assert.equal(calls.filter(({ path }) => path === '/api/lan/cancelPairing').length, 1);
});

test('a selected single address can be remembered after confirmation', async t => {
  const { document, host, view, calls } = fixture(t, {
    '/api/lan/status': () => modernLan,
    '/api/lan/enable': () => ({ ...modernLan, enabled: true, persistent: true, mode: 'single', endpoints: [lanEndpoints[1]] }),
  });
  await view.activate();
  const panel = host.querySelector('.lan-panel'), select = panel.querySelector('select'), toggle = panel.querySelector('input');
  select.value = vpn.address;
  select.dispatch('change');
  toggle.checked = true;
  toggle.dispatch('change');
  assert.ok(!calls.some(call => call.path.endsWith('/enable')));
  document.querySelector('dialog').querySelector('.primary').click();
  await settled();
  assert.deepEqual(calls.at(-1), { path: '/api/lan/enable', body: { address: vpn.address, port: 0, persistent: true, confirmed: true } });
  assert.equal(select.value, vpn.address);
  assert.equal(select.disabled, true);
  assert.match(panel.textContent, /已记住/);
});

test('SSH setup downloads the device script, copies its verified command and connects independently', async t => {
  let status = { enabled: false, remoteHostId: 'e'.repeat(32), remoteHostName: '书房电脑', sshRelay: { state: 'off' } };
  const origin = 'https://office.example.test:24861';
  const script = 'test installation script';
  const installCommand='verified installer command';
  const { document, host, view, panel, calls } = fixture(t, {
    '/api/lan/tunnel/status': () => status,
    '/api/lan/tunnel/enable': () => (status = { ...status, enabled: true, port: 49321, origin }),
    '/api/lan/tunnel/ssh/installer':()=>({script,command:installCommand,online:true,...status.sshRelay}),
    '/api/lan/tunnel/ssh/connect': ({publicOrigin,port}) => {
      status = {...status,enabled:true,origin:publicOrigin,port};
      status.sshRelay = { state: 'waiting', message: '等待 VPS 注册' };
      return status;
    },
    '/api/lan/tunnel/ssh/stop': () => (status.sshRelay = { state: 'off', message: '已停止' }),
  });
  const copied = [];
  document.defaultView.navigator.clipboard = { writeText: async value => copied.push(value) };
  await view.activate();
  const provider = panel.querySelector('select'), form = panel.querySelector('form'), field = panel.querySelector('#tunnel-public-origin');
  const install = button(panel, '获取安装命令'), identity = host.querySelector('.lan-identity');
  assert.deepEqual(calls.find(call => call.path === '/api/lan/tunnel/status'), { path: '/api/lan/tunnel/status', body: undefined });
  assert.match(identity.textContent, /书房电脑/);
  button(identity, '复制电脑 ID').click();
  provider.value = 'ssh';
  provider.dispatch('change');
  assert.equal(install.hidden, false);
  assert.equal(install.disabled, true);
  field.value = origin;
  field.dispatch('input');
  assert.equal(install.disabled, false);
  const random=panel.querySelector('.relay-port-option').querySelector('input');
  random.checked=true;random.dispatch('change');
  install.click();
  await settled();
  assert.deepEqual(calls.find(call=>call.path.endsWith('/ssh/installer')).body,{publicOrigin:origin,port:49321,randomPorts:true});
  assert.match(panel.querySelector('.tunnel-state').textContent,/已关闭/);
  assert.ok(!calls.some(call=>call.path.endsWith('/enable')||call.path.endsWith('/ssh/connect')));
  button(panel,'复制安装命令').click();await settled();
  assert.equal(panel.querySelector('.relay-command').value,installCommand);
  assert.equal(panel.querySelector('textarea').parentElement.open,false);
  const assigned='https://office.example.test:24560';
  field.value=assigned;field.dispatch('input');form.dispatch('submit');await settled();
  assert.deepEqual(calls.find(call => call.path.endsWith('/ssh/connect')).body,{publicOrigin:assigned,port:49321,previousOrigin:null});
  assert.equal(button(panel,'二维码配对').hidden,true);
  assert.deepEqual(copied, [status.remoteHostId, installCommand]);
  assert.match(panel.querySelector('.tunnel-state').textContent, /正在读取服务器配置/);
  assert.match(panel.querySelector('.tunnel-ssh-message').textContent, /等待 VPS 注册/);
  button(panel, '取消连接').click();
  await settled();
  assert.deepEqual(calls.find(call => call.path.endsWith('/ssh/stop')), { path: '/api/lan/tunnel/ssh/stop', body: {} });
  assert.equal(button(panel, '取消连接').hidden, true);
  assert.equal(button(panel, '关闭公网入口').hidden, false);
});

test('reopening a waiting relay shows its configuration, with manual copy if the clipboard is unavailable', async t => {
  const sshRelay = { state: 'waiting', message: '等待服务器' };
  const { document, view, panel } = fixture(t, {
    '/api/lan/tunnel/status': () => ({ ...tunnelEnabled, origin: 'https://office.example.test', sshRelay }),
    '/api/lan/tunnel/ssh/installer': () => ({ ...sshRelay,script:'installation script',command:'bash ./codecang-relay-setup.sh',online:false }),
  });
  await view.activate();
  assert.equal(panel.querySelector('select').value, 'ssh');
  assert.equal(panel.querySelector('.tunnel-configuration').hidden,false);
  button(panel, '获取安装命令').click();
  await settled();
  const fallback = panel.querySelector('.relay-command');
  button(panel,'复制安装命令').click();await settled();
  assert.equal(document.activeElement, fallback);
  assert.equal(fallback.value, 'bash ./codecang-relay-setup.sh');
  assert.equal(panel.querySelector('textarea').parentElement.open,false);
  view.deactivate();
  assert.equal(fallback.value, '');
});

test('relay polling preserves an edited address and reveals pairing only for a verified connection', async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const origin='https://office.example.test:24005';
  let relay={state:'connecting',message:'正在验证公网回源'};
  const {view,panel}=fixture(t,{'/api/lan/tunnel/status':()=>({...tunnelEnabled,origin,sshRelay:relay})});
  await view.activate();
  const field=panel.querySelector('#tunnel-public-origin');
  assert.equal(button(panel,'二维码配对').hidden,true);
  field.value='https://office.example.test:24006';field.dispatch('input');
  relay={state:'connected'};
  t.mock.timers.tick(3000);await settled();
  assert.equal(field.value,'https://office.example.test:24006');
  assert.equal(button(panel,'更换地址并连接').disabled,false);
  assert.equal(button(panel,'二维码配对').hidden,true);
  field.value=origin;field.dispatch('input');
  assert.equal(button(panel,'二维码配对').hidden,false);
  assert.match(panel.querySelector('.tunnel-state').textContent,/公网已连接/);
});

test('a failed SSH attempt does not mask the selected external tunnel',async t=>{
  const {view,panel}=fixture(t,{'/api/lan/tunnel/status':()=>({...tunnelEnabled,sshRelay:{state:'error',message:'SSH 连接失败'}})});
  await view.activate();
  const provider=panel.querySelector('#tunnel-provider');
  provider.value='frp';provider.dispatch('change');
  assert.match(panel.querySelector('.tunnel-state').textContent,/公网连通性未验证/);
  assert.equal(panel.querySelector('.tunnel-ssh-message').textContent,'');
  assert.equal(button(panel,'二维码配对').hidden,false);
});
