/** A bounded, safe Markdown subset. No HTML parsing, network fetches, or highlighting. */
export const MARKDOWN_LIMITS = Object.freeze({ chars: 65536, blocks: 400, inlineTokens: 4000, nodes: 12000, depth: 3, tableRows: 100, tableColumns: 24 });
const TRUNCATED = '…〔Markdown 显示已截断〕';
const safeText = value => typeof value === 'string' ? value : String(value ?? '');
const CONTROL = /[\u0000-\u001f\u007f]/;

export function safeLink(value) {
  const source = safeText(value).trim();
  if (!/^https?:\/\//i.test(source) || /[\u0000-\u0020\u007f]/.test(source)) return null;
  try { const url = new URL(source); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

function decode(value) {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try { return decodeURIComponent(value); } catch { return value; }
}

/**
 * Parses a Markdown destination as a local file reference.
 * Accepts Windows drive/UNC, POSIX absolute and relative paths (Chinese, spaces, percent-encoding),
 * `file:` URLs, and `#L12`, `#L12-L20`, `#L12C3`, `:12`, `:12:3`, `:12-20` suffixes.
 * Any other URL scheme (javascript:, vbscript:, data:, ms-*, shell:, …) is rejected.
 * The result is only a description; nothing here opens or reads the file.
 */
export function localPathRef(value, { cwd = '' } = {}) {
  let source = safeText(value).trim();
  if (source.startsWith('<') && source.endsWith('>')) source = source.slice(1, -1).trim();
  if (!source || source.length > 2048 || CONTROL.test(source)) return null;
  let path = source;
  const fileUrl = /^file:(?:\/\/(?:localhost)?)?(\/?)(.*)$/i.exec(path);
  if (fileUrl) {
    const rest = fileUrl[2];
    if (/^[A-Za-z]:[\\/]/.test(rest)) path = rest;
    else if (fileUrl[1]) path = '/' + rest;
    else return null;
  } else if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(path)) return null;
  path = decode(path);
  if (CONTROL.test(path)) return null;
  let line = null, column = null, endLine = null;
  const hash = path.lastIndexOf('#');
  if (hash >= 0) {
    const fragment = /^L(\d{1,7})(?:C(\d{1,5}))?(?:-L?(\d{1,7}))?$/i.exec(path.slice(hash + 1));
    if (fragment) { line = Number(fragment[1]); column = fragment[2] ? Number(fragment[2]) : null; endLine = fragment[3] ? Number(fragment[3]) : null; }
    path = path.slice(0, hash);
  }
  if (line === null) {
    const suffix = /:(\d{1,7})(?::(\d{1,5}))?(?:-(\d{1,7}))?$/.exec(path);
    if (suffix && suffix.index > 1) { line = Number(suffix[1]); column = suffix[2] ? Number(suffix[2]) : null; endLine = suffix[3] ? Number(suffix[3]) : null; path = path.slice(0, suffix.index); }
  }
  path = path.trim();
  if (!path || path === '.' || path === '..') return null;
  const windows = /^[A-Za-z]:[\\/]/.test(path), unc = /^\\\\[^\\/]+[\\/]/.test(path), posix = path.startsWith('/') && !path.startsWith('//');
  const absolute = windows || unc || posix;
  // Bare words such as "foo" are not treated as files; a relative path needs a separator or an extension.
  if (!absolute && (/^[#?]/.test(path) || !/[\\/]|\.[A-Za-z0-9]{1,12}$/.test(path))) return null;
  let fullPath = path;
  const base = safeText(cwd).replace(/[\\/]+$/, '');
  if (!absolute && base) {
    const sep = base.includes('\\') ? '\\' : '/';
    fullPath = base + sep + path.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep);
  }
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) || path;
  const location = line === null ? '' : `:${line}${column !== null ? ':' + column : ''}${endLine !== null ? '-' + endLine : ''}`;
  return { path, fullPath, name, line, column, endLine, absolute, location };
}

// Autolink-style <path>: HTML-looking text (attributes, quotes, closing tags) stays literal.
function angledPath(value, context) {
  const source = safeText(value);
  if (/["'=]|:\/\//.test(source) || /^\s|\s$/.test(source)) return null;
  const ref = localPathRef(source, context);
  if (!ref) return null;
  const segments = ref.path.split(/[\\/]/).filter(Boolean);
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(ref.path);
  // "</script>" is a tag, not a file: POSIX/relative paths need a directory or an extension.
  if (!windows && segments.length < 2 && !/\.[A-Za-z0-9]{1,12}$/.test(ref.path)) return null;
  return ref;
}
// Link destinations allow one level of balanced parentheses, e.g. `Program Files (x86)`, or `<…>` with spaces.
const DEST = '<[^<>\\n]{1,2048}>|(?:[^()\\n]|\\([^()\\n]{0,256}\\)){1,2048}';
const INLINE = new RegExp(String.raw`\\([\\` + '`' + String.raw`*_\[\]()<>])|(` + '`' + String.raw`{1,3})([^` + '`' + String.raw`\n]{0,4096})\2|\*\*([^\n]{1,4096}?)\*\*|__([^\n]{1,4096}?)__|\[([^\]\n]{1,512})\]\((` + DEST + String.raw`)\)|<([^<>\n]{1,2048})>`, 'g');

function destination(raw) {
  let value = safeText(raw).trim();
  if (value.startsWith('<') && value.endsWith('>')) return value;
  const titled = /^(.*?)\s+(?:"[^"\n]*"|'[^'\n]*')$/.exec(value);
  if (titled) value = titled[1].trim();
  return value;
}

function inline(source, context, depth = 0) {
  const text = safeText(source); const tokens = []; let previous = 0;
  if (context.astLeft <= 0) { context.truncated = true; return tokens; }
  const push = token => { if (context.astLeft-- > 0) tokens.push(token); else context.truncated = true; };
  if (depth >= MARKDOWN_LIMITS.depth || context.inlineLeft <= 0) { push({ type: 'text', text }); return tokens; }
  const pattern = new RegExp(INLINE.source, 'g'); let match;
  while (context.inlineLeft > 0 && context.astLeft > 0 && (match = pattern.exec(text))) {
    if (match.index > previous) push({ type: 'text', text: text.slice(previous, match.index) });
    context.inlineLeft--;
    if (match[1] !== undefined) push({ type: 'text', text: match[1] });
    else if (match[2]) push({ type: 'code', text: match[3] });
    else if (match[4] || match[5]) push({ type: 'strong', children: inline(match[4] || match[5], context, depth + 1) });
    else if (match[8] !== undefined) {
      const href = /^https?:\/\/[^\s]+$/i.test(match[8]) ? safeLink(match[8]) : null; const ref = href ? null : angledPath(match[8], context);
      if (href) push({ type: 'link', href, children: [{ type: 'text', text: match[8] }] });
      else if (ref) push({ type: 'file', ref, children: [{ type: 'text', text: ref.path }] });
      else push({ type: 'text', text: match[0] });
    } else {
      const target = destination(match[7]);
      const image = text[match.index - 1] === '!';
      const href = safeLink(target); const ref = href ? null : localPathRef(target, context);
      // Images are never loaded; unsafe or unknown destinations stay literal.
      if (image) push({ type: 'text', text: match[0] });
      else if (href) push({ type: 'link', href, children: inline(match[6], context, depth + 1) });
      else if (ref) push({ type: 'file', ref, children: inline(match[6], context, depth + 1) });
      else push({ type: 'text', text: match[0] });
    }
    previous = pattern.lastIndex;
  }
  if (previous < text.length) push({ type: 'text', text: text.slice(previous) });
  return tokens;
}
export function parseInline(text, { cwd = '' } = {}) { return inline(safeText(text).slice(0, MARKDOWN_LIMITS.chars), { inlineLeft: MARKDOWN_LIMITS.inlineTokens, astLeft: MARKDOWN_LIMITS.nodes, cwd }); }

function cells(line) {
  let source = line.trim(); if (source.startsWith('|')) source = source.slice(1); if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1);
  const values = []; let current = ''; let escaped = false;
  for (const char of source) {
    if (escaped) { current += char === '|' ? '|' : '\\' + char; escaped = false; }
    else if (char === '\\') escaped = true;
    else if (char === '|') { values.push(current.trim()); current = ''; if (values.length >= MARKDOWN_LIMITS.tableColumns) return values; }
    else current += char;
  }
  if (escaped) current += '\\'; values.push(current.trim()); return values.slice(0, MARKDOWN_LIMITS.tableColumns);
}
const fence = line => /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
const heading = line => /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
const listItem = line => /^ {0,3}(?:([-+*])\s+|(\d{1,9})[.)]\s+)(.*)$/.exec(line);
const quoted = line => /^ {0,3}>\s?(.*)$/.exec(line);
const separator = line => { const parts = cells(line); return parts.length > 0 && parts.every(x => /^:?-{3,}:?$/.test(x)); };
const isTable = (lines, i) => i + 1 < lines.length && lines[i].includes('|') && separator(lines[i + 1]);
function blocks(lines, context, depth = 0) {
  const result = []; let i = 0;
  const add = value => { if (context.blockLeft-- > 0) result.push(value); else context.truncated = true; };
  while (i < lines.length && context.blockLeft > 0) {
    if (!lines[i].trim()) { i++; continue; }
    const open = fence(lines[i]); const h = heading(lines[i]); const li = listItem(lines[i]); const quote = quoted(lines[i]);
    if (open) {
      const mark = open[1][0]; const length = open[1].length; const code = []; i++;
      while (i < lines.length && !(new RegExp(`^ {0,3}${mark === '`' ? '`' : '~'}{${length},}\\s*$`)).test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      add({ type: 'codeBlock', language: open[2].trim().split(/\s+/)[0].slice(0, 48), text: code.join('\n') });
    } else if (h) { add({ type: 'heading', level: h[1].length, children: inline(h[2], context) }); i++; }
    else if (isTable(lines, i)) {
      const headers = cells(lines[i]).map(x => inline(x, context)); const align = cells(lines[i + 1]).map(x => x.startsWith(':') ? x.endsWith(':') ? 'center' : 'left' : x.endsWith(':') ? 'right' : 'left');
      const rows = []; i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && rows.length < MARKDOWN_LIMITS.tableRows) {
        const row = cells(lines[i++]); rows.push(headers.map((_, index) => inline(row[index] || '', context)));
      }
      add({ type: 'table', headers, align, rows });
    } else if (li) {
      const ordered = !!li[2]; const items = []; const start = ordered ? Number(li[2]) : null;
      while (i < lines.length && items.length < 100) {
        const next = listItem(lines[i]); if (!next || !!next[2] !== ordered) break;
        // Indented continuation lines belong to the same item.
        const parts = [next[3]]; i++;
        while (i < lines.length && /^ {2,}\S/.test(lines[i]) && !listItem(lines[i])) parts.push(lines[i++].trim());
        items.push(inline(parts.join('\n'), context));
      }
      add({ type: 'list', ordered, start, items });
    } else if (quote && depth < MARKDOWN_LIMITS.depth) {
      const quotedLines = []; while (i < lines.length) { const q = quoted(lines[i]); if (!q) break; quotedLines.push(q[1]); i++; }
      add({ type: 'quote', children: blocks(quotedLines, context, depth + 1) });
    } else if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) { add({ type: 'rule' }); i++; }
    else {
      const paragraph = [lines[i++]];
      while (i < lines.length && lines[i].trim() && !fence(lines[i]) && !heading(lines[i]) && !listItem(lines[i]) && !quoted(lines[i]) && !isTable(lines, i)) paragraph.push(lines[i++]);
      add({ type: 'paragraph', children: inline(paragraph.join('\n'), context) });
    }
  }
  if (i < lines.length) context.truncated = true;
  return result;
}
function parse(value, cwd) {
  const original = safeText(value); const context = { inlineLeft: MARKDOWN_LIMITS.inlineTokens, astLeft: MARKDOWN_LIMITS.nodes, blockLeft: MARKDOWN_LIMITS.blocks, truncated: original.length > MARKDOWN_LIMITS.chars, cwd };
  const ast = blocks(original.slice(0, MARKDOWN_LIMITS.chars).replace(/\r\n?/g, '\n').split('\n'), context);
  return { ast, truncated: context.truncated };
}
export function parseMarkdown(value, { cwd = '' } = {}) {
  const { ast, truncated } = parse(value, cwd);
  if (truncated) ast.push({ type: 'paragraph', children: [{ type: 'text', text: TRUNCATED }] });
  return ast;
}

async function copyText(document, value, onCopy) {
  if (onCopy) return onCopy(value);
  const clipboard = document.defaultView?.navigator?.clipboard;
  if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
  return clipboard.writeText(value);
}

/**
 * Creates safe nodes using the supplied document.
 * Local file references become `<button class="md-file-link">` controls; `onLocalLink(ref, node)`
 * decides what they do. Without a handler they copy the path. They never navigate.
 * `complete: true`: if the source exceeds a formatting limit, render the whole source as plain text
 * instead of a truncated formatted prefix, so no content is dropped (long messages are split into
 * segments that normally stay within the limits).
 */
export function renderMarkdown(document, source, { onCopy, onLocalLink, cwd = '', complete = false } = {}) {
  if (complete) {
    const parsed = parse(source, cwd);
    const fragment = parsed.truncated ? null : renderAst(document, parsed.ast, { onCopy, onLocalLink });
    if (fragment && !fragment.exhausted) return fragment.node;
    const plain = document.createDocumentFragment();
    const note = document.createElement('p'); note.className = 'md-plain-note'; note.textContent = '此段格式超过渲染上限，按原文完整显示。';
    const pre = document.createElement('pre'); pre.className = 'md-plain'; pre.textContent = safeText(source);
    plain.append(note, pre); return plain;
  }
  const result = renderAst(document, parseMarkdown(source, { cwd }), { onCopy, onLocalLink });
  if (result.exhausted) { const notice = document.createElement('p'); notice.textContent = TRUNCATED; result.node.append(notice); }
  return result.node;
}
function renderAst(document, ast, { onCopy, onLocalLink }) {
  const fragment = document.createDocumentFragment(); let remaining = MARKDOWN_LIMITS.nodes; let exhausted = false;
  const create = (tag, className) => { if (--remaining < 0) { exhausted = true; return null; } const node = document.createElement(tag); if (className) node.className = className; return node; };
  const appendText = (parent, value) => { if (--remaining < 0) { exhausted = true; return; } parent.append(document.createTextNode(safeText(value))); };
  function fileControl(token) {
    const node = create('button', 'md-file-link'); if (!node) return null;
    const ref = token.ref;
    node.type = 'button';
    node.title = ref.fullPath + ref.location;
    node.setAttribute('data-path', ref.fullPath);
    if (ref.line !== null) node.setAttribute('data-line', String(ref.line));
    node.setAttribute('aria-label', `文件 ${ref.fullPath}${ref.location ? ' 第 ' + ref.location.slice(1) + ' 行' : ''}`);
    appendInline(node, token.children || []);
    if (ref.location && !safeText(node.textContent).endsWith(ref.location)) { const line = create('span', 'md-file-line'); if (line) { appendText(line, ref.location); node.append(line); } }
    node.addEventListener('click', async event => {
      event?.preventDefault?.();
      if (onLocalLink) { onLocalLink(ref, node); return; }
      try { await copyText(document, ref.fullPath, onCopy); node.setAttribute('data-copied', 'true'); } catch { node.setAttribute('data-copied', 'false'); }
    });
    return node;
  }
  function appendInline(parent, tokens) {
    for (const token of tokens) {
      if (remaining <= 0) { exhausted = true; break; }
      if (token.type === 'text') appendText(parent, token.text);
      else if (token.type === 'file') { const node = fileControl(token); if (!node) break; parent.append(node); }
      else {
        const tag = token.type === 'code' ? 'code' : token.type === 'strong' ? 'strong' : 'a'; const node = create(tag); if (!node) break;
        if (tag === 'a') { node.href = token.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; node.title = token.href; }
        if (token.type === 'code') appendText(node, token.text); else appendInline(node, token.children || []);
        parent.append(node);
      }
    }
  }
  function appendBlocks(parent, ast) {
    for (const block of ast) {
      if (remaining <= 0) { exhausted = true; break; }
      let node;
      if (block.type === 'codeBlock') {
        node = create('section', 'md-code-block'); const header = create('div', 'md-code-header'); const label = create('span', 'md-code-language'); const copy = create('button', 'md-code-copy'); const pre = create('pre'); const code = create('code');
        if (!node || !header || !label || !copy || !pre || !code) break;
        appendText(label, block.language || '文本'); copy.type = 'button'; appendText(copy, '复制'); copy.setAttribute('aria-label', '复制代码');
        copy.addEventListener('click', async () => {
          copy.disabled = true;
          try { await copyText(document, block.text, onCopy); copy.textContent = '已复制'; }
          catch { copy.textContent = '复制失败，请手动选择'; }
          finally { copy.disabled = false; }
        });
        header.append(label, copy); appendText(code, block.text); pre.append(code); node.append(header, pre);
      } else if (block.type === 'table') {
        node = create('div', 'md-table-wrap'); const table = create('table'); const head = create('thead'); const body = create('tbody'); if (!node || !table || !head || !body) break;
        const addRow = (target, values, heading = false) => { const tr = create('tr'); if (!tr) return; values.forEach((tokens, i) => { const cell = create(heading ? 'th' : 'td', `md-align-${block.align[i] || 'left'}`); if (!cell) return; if (heading) cell.setAttribute('scope', 'col'); appendInline(cell, tokens); tr.append(cell); }); target.append(tr); };
        addRow(head, block.headers, true); for (const row of block.rows) { if (remaining <= 0) break; addRow(body, row); } table.append(head, body); node.append(table);
      } else if (block.type === 'list') {
        node = create(block.ordered ? 'ol' : 'ul'); if (!node) break; if (block.ordered && block.start !== 1) node.setAttribute('start', String(block.start));
        for (const tokens of block.items) { const li = create('li'); if (!li) break; appendInline(li, tokens); node.append(li); }
      } else if (block.type === 'quote') { node = create('blockquote'); if (!node) break; appendBlocks(node, block.children); }
      else { node = create(block.type === 'heading' ? `h${block.level}` : block.type === 'rule' ? 'hr' : 'p'); if (!node) break; if (block.children) appendInline(node, block.children); }
      if (node) parent.append(node);
    }
  }
  appendBlocks(fragment, ast);
  return { node: fragment, exhausted };
}
