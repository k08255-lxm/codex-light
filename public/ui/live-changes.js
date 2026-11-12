// Composer-top live changes pill: "7 个文件已更改 +163 -34". Opens a panel with the real diffs.
// Scope: the running turn, or the most recent turn that edited files. Unknown counts stay unknown.
import { el } from './format.js';
import { icon } from '../icons.js';

/**
 * The pill shows the file changes of ONE turn: the running turn, otherwise the latest turn that
 * edited files. Per-turn net diffs each use their own starting state, so summing or cancelling them
 * across turns would fabricate a workspace diff. Earlier turns keep their own cards in the transcript.
 */
export function pillChanges(turns) {
  const list = Array.isArray(turns) ? turns : [];
  const turn = list.find(row => row.status === 'running' && row.files?.count) || [...list].reverse().find(row => row.files?.count) || null;
  if (!turn) return { count: 0, rows: [], running: false, added: null, removed: null, turnId: null };
  // Files whose net change in this turn is zero (e.g. edited then restored) are not "changed".
  const rows = turn.files.rows.filter(row => row.net !== 'unchanged');
  const known = rows.length > 0 && rows.every(row => row.known);
  return { count: rows.length, rows, running: turn.status === 'running', turnId: turn.id,
    added: known ? rows.reduce((sum, row) => sum + row.added, 0) : null, removed: known ? rows.reduce((sum, row) => sum + row.removed, 0) : null };
}

export function mountLiveChanges(host, { renderDiff }) {
  const document = host.ownerDocument;
  const pill = el(document, 'button', 'changes-pill'); pill.type = 'button'; pill.setAttribute('aria-expanded', 'false'); pill.setAttribute('aria-controls', 'changes-panel');
  const panel = el(document, 'section', 'changes-panel hidden'); panel.id = 'changes-panel'; panel.setAttribute('aria-label', '本轮已更改的文件');
  host.append(pill, panel);
  let summary = { count: 0, rows: [] }; let open = false; const expanded = new Set();
  pill.addEventListener('click', () => { open = !open; draw(); });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); open = false; draw(); pill.focus(); } });
  function stats(added, removed) {
    const span = el(document, 'span', 'diff-stats');
    if (added === null || removed === null) span.append(el(document, 'span', 'diff-unknown', '行数未知'));
    else span.append(el(document, 'span', 'diff-added', '+' + added), el(document, 'span', 'diff-removed', '-' + removed));
    return span;
  }
  function draw() {
    host.classList.toggle('hidden', !summary.count);
    if (!summary.count) { open = false; panel.classList.add('hidden'); return; }
    pill.replaceChildren(icon(document, 'diff', { size: 14 }), el(document, 'span', 'pill-text', `${summary.count} 个文件${summary.running ? '正在更改' : '已更改'}`), stats(summary.added, summary.removed));
    pill.dataset.running = String(!!summary.running);
    pill.setAttribute('aria-expanded', String(open));
    panel.classList.toggle('hidden', !open);
    if (!open) return;
    const head = el(document, 'div', 'changes-head'); head.append(el(document, 'strong', '', summary.running ? '本轮正在更改的文件' : '最近一轮更改的文件'), stats(summary.added, summary.removed));
    const close = el(document, 'button', 'btn icon-only'); close.type = 'button'; close.setAttribute('aria-label', '关闭'); close.append(icon(document, 'close', { size: 14 }));
    close.addEventListener('click', () => { open = false; draw(); pill.focus(); }); head.append(close);
    const list = el(document, 'ul', 'changes-list');
    for (const row of summary.rows) {
      const li = el(document, 'li', 'changes-row');
      const button = el(document, 'button', 'changes-file'); button.type = 'button'; button.title = row.fullPath;
      const slash = row.path.lastIndexOf('/');
      button.append(el(document, 'span', 'file-dir', slash >= 0 ? row.path.slice(0, slash + 1) : ''), el(document, 'span', 'file-base', slash >= 0 ? row.path.slice(slash + 1) : row.path), stats(row.added, row.removed));
      button.setAttribute('aria-expanded', String(expanded.has(row.path)));
      button.addEventListener('click', () => { if (expanded.has(row.path)) expanded.delete(row.path); else expanded.add(row.path); draw(); });
      li.append(button);
      if (expanded.has(row.path)) li.append(row.diffs.length ? renderDiff(document, row.diffs.join('\n')) : el(document, 'p', 'diff-empty', '没有可显示的差异内容。'));
      list.append(li);
    }
    panel.replaceChildren(head, list);
  }
  return { update(next) { summary = next; draw(); }, close() { open = false; draw(); }, isOpen: () => open };
}
