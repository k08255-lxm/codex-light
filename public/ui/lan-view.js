// LAN access settings (this computer only). Default off. The access URL comes only from the
// authenticated local management response; it is shown on demand and never stored.
import qrcode from '../vendor/qrcode.js';
import { el } from './format.js';

export function mountLanAccess(host, { api, notice = () => {} }) {
  const document = host.ownerDocument;
  let status = null, busy = false, reveal = false, generation = 0;
  const intro = el(document, 'p', 'fine', '让同一网络中的手机打开这个界面。默认关闭；链接包含独立访问令牌，轮换或关闭后旧链接立即失效。局域网连接是未加密的 HTTP，请只在可信网络中使用。');
  const panel = el(document, 'div', 'panel lan-panel');
  const state = el(document, 'div', 'pref-row');
  const stateText = el(document, 'div'); const stateTitle = el(document, 'strong', '', '局域网访问'); const stateSub = el(document, 'small', 'fine');
  stateText.append(stateTitle, stateSub);
  const toggle = el(document, 'input', 'switch'); toggle.type = 'checkbox'; toggle.setAttribute('aria-label', '局域网访问');
  state.append(stateText, toggle);
  const addressRow = el(document, 'label', 'pref-row');
  const addressText = el(document, 'div'); addressText.append(el(document, 'strong', '', '网络地址'), el(document, 'small', 'fine', '只列出本机私有 IPv4 地址'));
  const select = el(document, 'select'); select.setAttribute('aria-label', '网络地址');
  addressRow.append(addressText, select);
  const linkRow = el(document, 'div', 'lan-link hidden');
  const link = el(document, 'code', 'lan-url');
  const linkActions = el(document, 'div', 'work-row');
  const show = el(document, 'button', 'btn', '显示链接'); show.type = 'button';
  const copy = el(document, 'button', 'btn primary', '复制链接'); copy.type = 'button';
  const rotate = el(document, 'button', 'btn', '轮换令牌'); rotate.type = 'button'; rotate.title = '生成新链接并让旧链接与已连接的手机立即失效';
  const qrButton=el(document,'button','btn','二维码配对');qrButton.type='button';
  const qrPanel=el(document,'div','lan-qr hidden');let qrTimer=null;
  function clearQr(){clearTimeout(qrTimer);qrPanel.replaceChildren();qrPanel.classList.add('hidden');}
  qrButton.addEventListener('click',async()=>{
   if(busy)return;const mine=++generation;qrButton.disabled=true;clearQr();
   try{const result=await api('/api/lan/pairing',{});if(mine!==generation)return;const qr=qrcode(0,'M');qr.addData(result.url);qr.make();
    const canvas=document.createElement('canvas'),count=qr.getModuleCount(),scale=5;canvas.width=canvas.height=(count+8)*scale;canvas.style.width='min(260px,100%)';canvas.style.height='auto';canvas.setAttribute('role','img');canvas.setAttribute('aria-label','手机连接二维码，有效期两分钟，仅可使用一次');
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#000';for(let y=0;y<count;y++)for(let x=0;x<count;x++)if(qr.isDark(y,x))ctx.fillRect((x+4)*scale,(y+4)*scale,scale,scale);
    const close=el(document,'button','btn','取消配对');close.type='button';close.onclick=()=>{clearQr();api('/api/lan/cancelPairing',{}).catch(()=>{});};
    qrPanel.append(canvas,el(document,'p','fine','使用手机相机扫描。两分钟有效，仅限一次；仅在可信局域网使用。'),close);qrPanel.classList.remove('hidden');qrTimer=setTimeout(()=>{clearQr();say('二维码已过期，请重新生成。');},Math.max(0,result.expiresAt-Date.now()));
   }catch(error){say(error.message,true);}finally{qrButton.disabled=false;}
  });
  linkActions.append(qrButton,show, copy, rotate);
  linkRow.append(link, linkActions,qrPanel);
  const message = el(document, 'p', 'fine'); message.setAttribute('role', 'status');
  panel.append(state, addressRow, linkRow);
  host.replaceChildren(intro, panel, message);

  const say = (text, error = false) => { message.textContent = text; message.classList.toggle('inline-error', error); };
  function masked(url) { return String(url).replace(/#token=.*/, '#token=••••••••'); }
  function render() {
    const enabled = !!status?.enabled;
    toggle.checked = enabled; toggle.disabled = busy || !status || (!enabled && !select.value);
    stateSub.textContent = !status ? '读取中…' : enabled ? `已开启 · ${status.origin || ''}` : '已关闭';
    const addresses = Array.isArray(status?.addresses) ? status.addresses : [];
    const current = select.value || status?.address || '';
    select.replaceChildren(...addresses.map(row => { const option = el(document, 'option', '', `${row.address}（${row.name || '网络'}）`); option.value = row.address; return option; }));
    if (!addresses.length) { const option = el(document, 'option', '', '没有可用的私有 IPv4 地址'); option.value = ''; select.append(option); }
    select.value = addresses.some(row => row.address === current) ? current : addresses[0]?.address || '';
    select.disabled = busy || enabled || !addresses.length;
    toggle.disabled = busy || !status || (!enabled && !select.value);
    linkRow.classList.toggle('hidden', !enabled || !status?.url);
    link.textContent = status?.url ? (reveal ? status.url : masked(status.url)) : '';
    show.textContent = reveal ? '隐藏链接' : '显示链接';
    for (const button of [qrButton,show, copy, rotate]) button.disabled = busy;
  }
  async function call(path, body) {
    clearQr(); const mine = ++generation; busy = true; render();
    try { const result = await api(path, body); if (mine === generation) { status = result; } return result; }
    catch (error) { if (mine === generation) say(error.message, true); throw error; }
    finally { if (mine === generation) { busy = false; render(); } }
  }
  toggle.addEventListener('change', async () => {
    const wanted = toggle.checked; toggle.checked = !wanted; // reflect actual state only after the server confirms
    say('');
    try {
      if (wanted) { await call('/api/lan/enable', { address: select.value, port: 0 }); reveal = false; say('已开启。复制链接，在手机浏览器中打开。'); }
      else { await call('/api/lan/disable', {}); reveal = false; say('已关闭；旧链接已失效。'); }
    } catch {}
  });
  show.addEventListener('click', () => { reveal = !reveal; render(); });
  copy.addEventListener('click', async () => {
    if (!status?.url) return;
    try { await navigator.clipboard.writeText(status.url); say('链接已复制。它包含访问令牌，请只发给自己的设备。'); }
    catch { reveal = true; render(); say('无法写入剪贴板，请手动复制上面的链接。', true); }
  });
  rotate.addEventListener('click', async () => { try { await call('/api/lan/rotate', {}); reveal = false; say('已轮换：旧链接与已连接的手机已失效。'); } catch {} });
  select.addEventListener('change', render);
  render();
  return {
    async activate() { reveal = false; say(''); try { await call('/api/lan/status', {}); } catch {} },
    deactivate() { clearQr(); api('/api/lan/cancelPairing',{}).catch(()=>{}); reveal = false; generation++; busy = false; render(); },
    snapshot: () => status,
  };
}
