import qrcode from '../vendor/qrcode.js';
import { el } from './format.js';

export function createAccessPairing(document, { description, copyLink = false, say, cancel }) {
  const element = el(document, 'div', 'lan-qr hidden');
  let timer;

  function clear() {
    const visible = !element.classList.contains('hidden');
    clearTimeout(timer);
    element.replaceChildren();
    element.classList.add('hidden');
    return visible;
  }

  function show({ url, expiresAt }) {
    clear();
    const remaining = expiresAt - Date.now();
    if (typeof url !== 'string' || !Number.isFinite(remaining) || remaining <= 0) {
      throw new Error('配对链接无效或已过期，请重新生成。');
    }
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const canvas = document.createElement('canvas');
    const count = qr.getModuleCount(), scale = 5;
    canvas.width = canvas.height = (count + 8) * scale;
    canvas.style.width = 'min(260px,100%)';
    canvas.style.height = 'auto';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '手机配对二维码，两分钟有效，仅可使用一次');
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let y = 0; y < count; y++) {
      for (let x = 0; x < count; x++) {
        if (qr.isDark(y, x)) ctx.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
      }
    }

    const actions = el(document, 'div', 'work-row');
    const close = el(document, 'button', 'btn', '取消配对');
    close.type = 'button';
    close.addEventListener('click', () => { clear(); cancel(); });
    element.append(canvas, el(document, 'p', 'fine', description));
    if (copyLink) {
      const manualLink = el(document, 'code', 'lan-url hidden');
      const copy = el(document, 'button', 'btn', '复制配对链接');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await document.defaultView.navigator.clipboard.writeText(url);
          if (element.contains(copy)) say('一次性配对链接已复制。');
        } catch {
          if (!element.contains(copy)) return;
          manualLink.textContent = url;
          manualLink.classList.remove('hidden');
          say('无法写入剪贴板，请手动复制配对链接。', true);
        }
      });
      element.append(manualLink);
      actions.append(copy);
    }
    actions.append(close);
    element.append(actions);
    element.classList.remove('hidden');
    timer = setTimeout(() => { clear(); say('配对链接已过期，请重新生成。'); }, remaining);
  }

  return { element, show, clear };
}
