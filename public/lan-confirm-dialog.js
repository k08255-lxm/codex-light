// App-owned consent surface. Never substitute acceptance for dismissal or navigation.
let sequence = 0;
export function confirmLanPersistence(document, { signal, opener = document.activeElement } = {}) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'lan-confirm-dialog';
    const title = document.createElement('h2');
    title.id = `lan-confirm-title-${++sequence}`;
    title.textContent = '开启并记住局域网访问？';
    dialog.setAttribute('aria-labelledby', title.id);
    const body = document.createElement('div');
    body.className = 'lan-confirm-body';
    body.id = `${title.id}-description`;
    dialog.setAttribute('aria-describedby', body.id);
    for (const text of [
      '开启后，应用启动时会自动恢复同一已确认的 Windows 可信网络上的访问，保留端口和配对令牌。只有你主动关闭，才会取消恢复并使旧配对失效。',
      '连接使用未加密的 HTTP，仅在可信网络中开启。访问链接包含独立令牌，请勿分享给不可信的人。',
    ]) {
      const paragraph = document.createElement('p'); paragraph.textContent = text; body.append(paragraph);
    }
    const actions = document.createElement('div'); actions.className = 'lan-confirm-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = '取消';
    const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'btn primary'; accept.textContent = '开启并记住';
    actions.append(cancel, accept); dialog.append(title, body, actions);
    let settled = false;
    const finish = accepted => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      if (dialog.open) dialog.close();
      dialog.remove();
      if (opener?.isConnected) opener.focus();
      resolve(accepted);
    };
    const abort = () => finish(false);
    cancel.addEventListener('click', abort);
    accept.addEventListener('click', () => finish(!signal?.aborted));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.addEventListener('close', abort);
    signal?.addEventListener('abort', abort, { once: true });
    document.body.append(dialog);
    try { dialog.showModal(); cancel.focus(); } catch { finish(false); }
  });
}
