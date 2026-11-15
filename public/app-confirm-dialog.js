// App-owned consent surface. Never substitute acceptance for dismissal or navigation.
let sequence = 0;
const active = new WeakSet();
export function confirmApp(document, message, { signal, opener = document.activeElement, titleText = '请确认操作', acceptText = '确认' } = {}) {
  if (active.has(document) || signal?.aborted) return Promise.resolve(false);
  active.add(document);
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'lan-confirm-dialog';
    const title = document.createElement('h2');
    title.id = `lan-confirm-title-${++sequence}`;
    title.textContent = titleText;
    dialog.setAttribute('aria-labelledby', title.id);
    const body = document.createElement('div');
    body.className = 'lan-confirm-body';
    body.id = `${title.id}-description`;
    dialog.setAttribute('aria-describedby', body.id);
    for (const text of String(message).split('\n')) {
      const paragraph = document.createElement('p'); paragraph.textContent = text; body.append(paragraph);
    }
    const actions = document.createElement('div'); actions.className = 'lan-confirm-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = '取消';
    const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'btn primary'; accept.textContent = acceptText;
    actions.append(cancel, accept); dialog.append(title, body, actions);
    let settled = false;
    const finish = accepted => {
      if (settled) return;
      settled = true; active.delete(document);
      document.defaultView?.removeEventListener?.('pagehide', abort);
      document.defaultView?.removeEventListener?.('popstate', abort); signal?.removeEventListener('abort', abort);
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
    document.defaultView?.addEventListener?.('pagehide', abort, { once: true });
    document.defaultView?.addEventListener?.('popstate', abort, { once: true });
    document.body.append(dialog);
    try { dialog.showModal(); cancel.focus(); } catch { finish(false); }
  });
}
