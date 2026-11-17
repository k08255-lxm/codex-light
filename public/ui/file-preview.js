/** Host files are fetched through the authenticated bridge, never opened as phone-local paths. */
export function createFilePreview({document, fetchPreview}) {
  const el = (tag, className, text) => {const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;};
  const dialog = el('dialog', 'file-preview');
  dialog.setAttribute('aria-label', '文件预览');
  const header = el('header', 'file-preview-header'), heading = el('div', 'file-preview-heading');
  const title = el('strong', 'file-preview-title'), pathname = el('div', 'file-preview-path');
  heading.append(title, pathname);
  const closeButton = el('button', 'file-preview-close', '×');
  closeButton.type = 'button'; closeButton.setAttribute('aria-label', '关闭文件预览');
  header.append(heading, closeButton);
  const stage = el('div', 'file-preview-stage');
  stage.tabIndex = 0; stage.setAttribute('aria-label', '文件内容，可滚动查看');
  const footer = el('footer', 'file-preview-footer'), detail = el('span', 'file-preview-detail');
  const paging = el('div', 'file-preview-paging');
  const previous = el('button', 'btn ghost small', '上一段'), next = el('button', 'btn ghost small', '下一段');
  previous.type = next.type = 'button'; paging.append(previous, next); footer.append(detail, paging);
  dialog.append(header, stage, footer); document.body.append(dialog);
  let request = null, opener = null, currentRef = null, scope = null, result = null, destroyed = false;

  function clear() {
    request?.abort(); request = null; result = null;
    stage.replaceChildren(); stage.removeAttribute('aria-busy');
    if (opener?.isConnected) opener.focus?.();
    opener = null;
  }
  function close() {if (dialog.open) dialog.close(); clear();}
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => {event.preventDefault(); close();});
  dialog.addEventListener('close', () => {if (!dialog.open) clear();});
  dialog.addEventListener('click', event => {if (event.target === dialog) {const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();}});

  function status(message, error = false) {
    const wrap = el('div', 'file-preview-state' + (error ? ' is-error' : ''));
    const text = el('p', '', message); text.setAttribute('role', error ? 'alert' : 'status'); wrap.append(text);
    if (error) {const retry = el('button', 'btn ghost', '重试'); retry.type = 'button'; retry.addEventListener('click', () => load(currentRef)); wrap.append(retry);}
    stage.replaceChildren(wrap);
  }

  function render(file) {
    stage.replaceChildren(); stage.scrollTop = stage.scrollLeft = 0;
    paging.hidden = true;
    if (file.kind === 'image') {
      if (!/^image\/(png|jpeg|webp|gif|vnd\.microsoft\.icon|svg\+xml)$/.test(file.mime) || typeof file.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new Error('图片预览数据无效');
      const image = el('img', 'file-preview-image'); image.alt = file.name || '图片';
      image.addEventListener('error', () => {if (result === file) status('无法解码该图片，请重试。', true);});
      image.src = `data:${file.mime};base64,${file.base64}`; stage.append(image);
      detail.textContent = `${file.width} × ${file.height}`;
      return;
    }
    if (file.kind !== 'text' || typeof file.text !== 'string' || !Number.isInteger(file.startLine) || !Number.isInteger(file.totalLines)) throw new Error('文件预览数据无效');
    const code = el('div', 'file-preview-code'), lines = file.text.split('\n');
    let selected = null;
    for (const [offset, text] of lines.entries()) {
      const line = file.startLine + offset, active = file.line !== null && line >= file.line && line <= file.endLine;
      const row = el('div', 'file-preview-row' + (active ? ' is-selected' : ''));
      row.dataset.line = String(line);
      const number = el('span', 'file-preview-number', String(line)); number.setAttribute('aria-hidden', 'true');
      const value = el('code', 'file-preview-source', text || '\u200b'); row.append(number, value); code.append(row);
      if (active && !selected) selected = row;
    }
    stage.append(code);
    detail.textContent = file.truncated ? `第 ${file.startLine}–${file.startLine + lines.length - 1} 行 · 共 ${file.totalLines} 行` : `${file.totalLines} 行`;
    paging.hidden = !file.truncated;
    previous.disabled = file.startLine <= 1;
    next.disabled = file.startLine + lines.length - 1 >= file.totalLines;
    selected?.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
  }

  async function load(ref) {
    if (destroyed) return;
    request?.abort();
    const pending = new AbortController(); request = pending; currentRef = {...ref}; result = null;
    title.textContent = ref.name || ref.fullPath?.split(/[\\/]/).at(-1) || '文件预览';
    pathname.textContent = ref.fullPath || ref.path || ''; pathname.title = pathname.textContent;
    stage.setAttribute('aria-busy', 'true'); paging.hidden = true; detail.textContent = '';
    status('正在读取电脑上的文件…');
    const input = {...scope, path: ref.fullPath || ref.path};
    if (Number.isInteger(ref.line) && ref.line > 0) input.line = ref.line;
    if (input.line && Number.isInteger(ref.endLine) && ref.endLine >= input.line) input.endLine = ref.endLine;
    try {
      const file = await fetchPreview(input, {signal: pending.signal});
      if (request !== pending || pending.signal.aborted || destroyed) return;
      result = file; render(file);
    } catch (error) {
      if (request !== pending || pending.signal.aborted || destroyed) return;
      result = null; status(error?.message || '文件读取失败，请重试。', true);
    } finally {if (request === pending) {stage.removeAttribute('aria-busy'); request = null;}}
  }
  function page(direction) {
    if (!result || result.kind !== 'text') return;
    const count = result.text.split('\n').length;
    const line = Math.max(1, Math.min(result.totalLines, result.startLine + direction * count + count / 4));
    void load({...currentRef, line: Math.floor(line), endLine: null});
  }
  previous.addEventListener('click', () => page(-1)); next.addEventListener('click', () => page(1));

  return {
    open(ref, selectedScope, trigger) {
      if (destroyed) return Promise.resolve();
      if (!dialog.open) opener = trigger || document.activeElement;
      scope = {...selectedScope};
      if (!dialog.open) dialog.showModal();
      closeButton.focus();
      return load(ref);
    },
    close,
    destroy() {destroyed = true; close(); dialog.remove();},
  };
}
