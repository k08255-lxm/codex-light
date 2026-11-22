// LAN access settings (this computer only). Default off. The access URL comes only from the
// authenticated local management response; it is shown on demand and never stored.
import { confirmLanPersistence } from '../lan-confirm-dialog.js';
import { createAccessPairing } from './access-pairing-view.js';
import { el } from './format.js';
import { mountTunnelAccess } from './tunnel-view.js';

const ALL_ADDRESSES = 'auto';

export function mountLanAccess(host, { api, notice = () => {} }) {
  const document = host.ownerDocument;
  let status = null, busy = false, reveal = false, generation = 0, poll = null, active = false;
  let consent = null, selectedAddress = '', selectedEndpoint = '', cancellation = null;
  const intro = el(document, 'p', 'fine', '让同一网络中的手机连接此电脑。局域网使用未加密的 HTTP，请在可信网络中开启。');
  const panel = el(document, 'div', 'panel lan-panel');
  const state = el(document, 'div', 'pref-row');
  const stateText = el(document, 'div'); const stateTitle = el(document, 'strong', '', '局域网访问'); const stateSub = el(document, 'small', 'fine');
  stateText.append(stateTitle, stateSub);
  const toggle = el(document, 'input', 'switch'); toggle.type = 'checkbox'; toggle.setAttribute('aria-label', '局域网访问');
  state.append(stateText, toggle);
  const addressRow = el(document, 'label', 'pref-row lan-address-row');
  const addressText = el(document, 'div');
  const addressTitle = el(document, 'strong', '', '监听地址');
  const addressHint = el(document, 'small', 'fine');
  addressText.append(addressTitle, addressHint);
  const select = el(document, 'select');
  addressRow.append(addressText, select);
  const linkRow = el(document, 'div', 'lan-link hidden');
  const link = el(document, 'code', 'lan-url');
  const linkActions = el(document, 'div', 'work-row');
  const show = el(document, 'button', 'btn', '显示链接'); show.type = 'button';
  const copy = el(document, 'button', 'btn primary', '复制链接'); copy.type = 'button';
  const rotate = el(document, 'button', 'btn', '轮换令牌'); rotate.type = 'button'; rotate.title = '生成新链接并让旧链接与已连接的手机立即失效';
  const qrButton = el(document, 'button', 'btn', '二维码配对');
  qrButton.type = 'button';
  let pairingPending = false;
  const pairing = createAccessPairing(document, {
    description: '使用手机相机扫描。两分钟有效，仅限一次。请在可信局域网使用。',
    say: (text, error) => say(text, error),
    cancel: () => { void cancelPairing(true); },
  });
  qrButton.addEventListener('click', async () => {
    const endpoint = currentEndpoint();
    if (!active || busy || consent || !endpoint?.url || pairingPending || cancellation) return;
    const mine = ++generation;
    pairingPending = true;
    pairing.clear();
    render();
    try {
      const result = await api('/api/lan/pairing', supportsAuto() ? { address: endpoint.address } : {});
      if (mine === generation) pairing.show(result);
      else await cancelPairing();
    } catch (error) {
      if (mine === generation) say(error.message, true);
    } finally {
      pairingPending = false;
      render();
    }
  });
  linkActions.append(qrButton, show, copy, rotate);
  linkRow.append(link, linkActions, pairing.element);
  const retry=el(document,'button','btn','重试恢复');retry.type='button';retry.classList.add('hidden');retry.addEventListener('click',async()=>{try{await call('/api/lan/restore',{});}catch{}});
  const message = el(document, 'p', 'fine'); message.setAttribute('role', 'status');
  panel.append(state, addressRow, linkRow, retry);

  const identityPanel = el(document, 'section', 'panel lan-identity hidden');
  const identityName = el(document, 'h3');
  const identityDetails = el(document, 'details');
  const identitySummary = el(document, 'summary');
  const identityCode = el(document, 'code', 'lan-url');
  const identityCopy = el(document, 'button', 'btn', '复制电脑 ID');
  identityCopy.type = 'button';
  const identityStatus = el(document, 'p', 'fine');
  identityStatus.setAttribute('role', 'status');
  identityDetails.append(identitySummary, identityCode, identityCopy, identityStatus);
  identityPanel.append(identityName, el(document, 'p', 'fine', '手机用这个 ID 识别同一台电脑的内外网线路，应用升级后沿用。'), identityDetails);
  identityCopy.addEventListener('click', async () => {
    try {
      await document.defaultView.navigator.clipboard.writeText(identityCode.textContent);
      if (active) identityStatus.textContent = '电脑 ID 已复制。';
    } catch {
      if (active) identityStatus.textContent = '无法写入剪贴板，请手动复制上面的电脑 ID。';
    }
  });

  const tunnelHost = el(document, 'div');
  const tunnel = mountTunnelAccess(tunnelHost, { api, onIdentity: ({ id, name }) => {
    const title = name || '本机电脑';
    if (identityName.textContent !== title) identityName.textContent = title;
    if (identityCode.textContent !== id) {
      identitySummary.textContent = `电脑 ID · ${id.slice(0, 8)}`;
      identityCode.textContent = id;
      identityStatus.textContent = '';
    }
    identityPanel.classList.remove('hidden');
  } });
  host.replaceChildren(identityPanel, intro, panel, message, tunnelHost);

  const say = (text, error = false) => { message.textContent = text; message.classList.toggle('inline-error', error); };
  function masked(url) { return url.replace(/#token=.*/, '#token=••••••••'); }

  function supportsAuto() {
    return Array.isArray(status?.endpoints);
  }

  function activeEndpoints() {
    if (!status?.enabled) return [];
    if (supportsAuto()) return status.endpoints;
    return status.address ? [{ address: status.address, origin: status.origin, url: status.url }] : [];
  }

  function currentEndpoint(endpoints = activeEndpoints()) {
    return endpoints.find(endpoint => endpoint.address === selectedEndpoint) || endpoints[0];
  }

  function cancelPairing(reportError = false) {
    if (cancellation) return cancellation;
    const mine = generation;
    cancellation = api('/api/lan/cancelPairing', {}).catch(() => {
      if (reportError && mine === generation) say('取消配对失败。原二维码仍可能在有效期内使用。', true);
    }).finally(() => { cancellation = null; render(); });
    render();
    return cancellation;
  }

  function applyStatus(result) {
    const previous = currentEndpoint()?.url;
    status = result;
    const current = currentEndpoint()?.url;
    if (previous !== current) {
      pairing.clear();
      reveal = false;
    }
  }

  function render() {
    const enabled = !!status?.enabled, desired = enabled || !!status?.persistent;
    const addresses = Array.isArray(status?.addresses) ? status.addresses : [];
    const endpoints = activeEndpoints();
    const endpoint = currentEndpoint(endpoints);
    const modeLabel = status?.mode === ALL_ADDRESSES ? `正在监听 ${endpoints.length} 个私有 IPv4 地址` : endpoint?.origin || '';
    retry.classList.toggle('hidden', enabled || !status?.persistent);
    retry.disabled = busy;
    toggle.checked = desired;
    stateSub.textContent = !status ? '读取中…' : status.restoring ? '正在安全恢复…' : enabled ? `已开启 · ${modeLabel}${status.persistent ? ' · 已记住' : ''}` : status.persistent ? `已保持开启设置 · ${status.restoreError || '等待恢复'}` : status.restoreError || '已关闭';

    if (selectedAddress !== ALL_ADDRESSES && !addresses.some(row => row.address === selectedAddress)) selectedAddress = '';
    const rows = enabled ? endpoints : addresses;
    const options = rows.map(row => {
      const name = row.name || addresses.find(available => available.address === row.address)?.name;
      const option = el(document, 'option', '', name ? `${row.address}（${name}）` : row.address);
      option.value = row.address;
      return option;
    });
    if (!enabled && supportsAuto() && addresses.length) {
      const option = el(document, 'option', '', '全部可用局域网地址');
      option.value = ALL_ADDRESSES;
      options.unshift(option);
    }
    if (!options.length) options.push(el(document, 'option', '', '没有可用的私有 IPv4 地址'));
    const label = enabled ? '配对地址' : '监听地址';
    addressTitle.textContent = label;
    addressHint.textContent = enabled ? '选择手机所在网络的地址。' : '仅监听当前可用的私有 IPv4 地址。Windows 可记住单个地址。';
    select.setAttribute('aria-label', label);
    select.replaceChildren(...options);
    const fallback = rows.length ? options[0].value : '';
    select.value = enabled ? endpoint?.address || '' : (options.some(option => option.value === selectedAddress) ? selectedAddress : fallback);
    select.disabled = !!consent || busy || !rows.length || (enabled && endpoints.length < 2);
    toggle.disabled = !!consent || busy || !!status?.restoring || !status || (!desired && !select.value);
    linkRow.classList.toggle('hidden', !endpoint?.url);
    link.textContent = endpoint?.url ? (reveal ? endpoint.url : masked(endpoint.url)) : '';
    show.textContent = reveal ? '隐藏链接' : '显示链接';
    for (const button of [show, copy, rotate]) button.disabled = busy;
    qrButton.disabled = busy || pairingPending || !!cancellation;
  }
  async function call(path, body) {
    pairing.clear(); const mine = ++generation; busy = true; render();
    try { const result = await api(path, body); if (mine === generation) applyStatus(result); return result; }
    catch (error) { if (mine === generation) say(error.message, true); throw error; }
    finally { if (mine === generation) { busy = false; render(); } }
  }
  toggle.addEventListener('change', async () => {
    if (consent || busy) { render(); return; }
    const wanted = toggle.checked; toggle.checked = !wanted; // reflect actual state only after the server confirms
    say('');
    try {
      if (wanted) {
        const address = select.value;
        const persistent = address !== ALL_ADDRESSES && !!status?.persistenceAvailable;
        if (persistent) {
          const controller = new AbortController();
          const mine = generation;
          consent = controller; render();
          const accepted = await confirmLanPersistence(document, { signal: controller.signal, opener: toggle });
          if (consent === controller) consent = null;
          render();
          if (active && !toggle.disabled) toggle.focus();
          if (!accepted || controller.signal.aborted || mine !== generation || !active) return;
        }
        selectedEndpoint = address === ALL_ADDRESSES ? '' : address;
        await call('/api/lan/enable', { address, port: 0, persistent, ...(persistent ? { confirmed: true } : {}) });
        say(persistent ? '已保存。应用下次启动时会尝试在同一可信网络恢复。' : '已临时开启，应用退出后关闭。请选择手机所在网络的地址配对。');
      }
      else { await call('/api/lan/disable', {});render(); reveal = false; say('已关闭；旧链接已失效。'); }
    } catch {}
  });
  show.addEventListener('click', () => { reveal = !reveal; render(); });
  copy.addEventListener('click', async () => {
    const url = currentEndpoint()?.url;
    if (!url) return;
    try {
      await document.defaultView.navigator.clipboard.writeText(url);
      if (active && url === currentEndpoint()?.url) say('链接已复制。它包含访问令牌，请只发给自己的设备。');
    } catch {
      if (!active || url !== currentEndpoint()?.url) return;
      reveal = true;
      render();
      say('无法写入剪贴板，请手动复制上面的链接。', true);
    }
  });
  rotate.addEventListener('click', async () => { try { await call('/api/lan/rotate', {}); reveal = false; say('已轮换：旧链接与已连接的手机已失效。'); } catch {} });
  select.addEventListener('change', () => {
    if (status?.enabled) {
      selectedEndpoint = select.value;
      generation++;
      reveal = false;
      say('');
      if (pairing.clear()) void cancelPairing(true);
    } else {
      selectedAddress = select.value;
    }
    render();
  });
  render();
  return {
    async activate() {
      if (active) return;
      active = true;
      reveal = false;
      say('');
      poll = setInterval(async () => {
        if (busy || consent || pairingPending) return;
        const mine = generation;
        try {
          const result = await api('/api/lan/status', {});
          if (mine === generation) { applyStatus(result); render(); }
        } catch {}
      }, 15000);
      await Promise.all([tunnel.activate(), call('/api/lan/status', {}).catch(() => {})]);
    },
    deactivate() {
      if (!active) return;
      tunnel.deactivate();
      active = false;
      consent?.abort();
      consent = null;
      clearInterval(poll);
      poll = null;
      if (pairing.clear()) void cancelPairing();
      reveal = false;
      generation++;
      busy = false;
      render();
    },
    snapshot: () => status,
  };
}
