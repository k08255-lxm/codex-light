// Composer-top live changes pill: "7 个文件已更改 +163 -34". Opens a panel with the real diffs.
// Scope: the running turn, or the most recent turn that edited files. Unknown counts stay unknown.
import { el } from './format.js';
import { icon } from '../icons.js';
import {summarizeFileRows} from '../change-stats.js';
import {statsNode} from '../activity-feed.js';

/**
 * The pill shows the file changes of ONE turn: the running turn, otherwise the latest turn that
 * edited files. Per-turn net diffs each use their own starting state, so summing or cancelling them
 * across turns would fabricate a workspace diff. Earlier turns keep their own cards in the transcript.
 */
export function pillChanges(turns) {
  const list = Array.isArray(turns) ? turns : [];
  const turn = [...list].reverse().find(row => row.status==='running'&&row.files?.count) || null;
  if (!turn) return { count: 0, rows: [], running: false, added: null, removed: null, turnId: null };
  // Files whose net change in this turn is zero (e.g. edited then restored) are not "changed".
  const rows = turn.files.rows.filter(row => row.net !== 'unchanged');
  return {...summarizeFileRows(rows,turn.status==='running'),turnId:turn.id};
}

export function mountLiveChanges(host, { renderDiff }) {
  const document = host.ownerDocument;
  const pill = el(document, 'button', 'changes-pill'); pill.type = 'button'; pill.setAttribute('aria-expanded', 'false'); pill.setAttribute('aria-controls', 'changes-panel');
  const panel = el(document, 'section', 'changes-panel hidden'); panel.id = 'changes-panel'; panel.setAttribute('aria-label', '本轮已更改的文件');
  host.append(pill, panel);
  let summary = { count: 0, rows: [] }; let open = false; const expanded = new Set();
  pill.addEventListener('click', () => { open = !open; draw(); });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); open = false; draw(); pill.focus(); } });
  const stats = evidence => statsNode(document,evidence.added,evidence.removed,evidence);
  function draw() {
    panel.style.maxWidth=Math.max(220,(host.parentElement?.clientWidth||560)-24)+'px';
    host.classList.toggle('hidden', !summary.count);
    if (!summary.count) { open = false; panel.classList.add('hidden'); return; }
    pill.replaceChildren(icon(document, 'diff', { size: 14 }), el(document, 'span', 'pill-text', `${summary.count} 个文件${summary.running ? '正在更改' : '已更改'}`), stats(summary));
    pill.dataset.running = String(!!summary.running);
    pill.setAttribute('aria-expanded', String(open));
    panel.classList.toggle('hidden', !open);
    if (!open) return;
    const head = el(document, 'div', 'changes-head'); head.append(el(document, 'strong', '', summary.running ? '本轮正在更改的文件' : '最近一轮更改的文件'), stats(summary));
    const close = el(document, 'button', 'btn icon-only'); close.type = 'button'; close.setAttribute('aria-label', '关闭'); close.append(icon(document, 'close', { size: 14 }));
    close.addEventListener('click', () => { open = false; draw(); pill.focus(); }); head.append(close);
    const list = el(document, 'ul', 'changes-list');
    for (const row of summary.rows) {
      const li = el(document, 'li', 'changes-row');
      const button = el(document, 'button', 'changes-file'); button.type = 'button'; button.title = row.fullPath;
      const slash = row.path.lastIndexOf('/');
      button.append(el(document, 'span', 'file-dir', slash >= 0 ? row.path.slice(0, slash + 1) : ''), el(document, 'span', 'file-base', slash >= 0 ? row.path.slice(slash + 1) : row.path), stats(row));
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

/** A viewport control only: never changes whether new messages automatically follow. */
export function mountScrollToBottom(conversation) {
  const document=conversation.ownerDocument,window=document.defaultView;
  const parent=conversation.parentElement;
  const hadAnchor=parent.classList.contains('scroll-button-host');parent.classList.add('scroll-button-host');
  const button=el(document,'button','scroll-to-bottom');button.type='button';button.hidden=true;
  button.setAttribute('aria-label','回到底部');button.title='回到底部';button.append(icon(document,'down',{size:17}));
  parent.append(button);
  let frame=null;
  function update(){
    frame=null;
    const visible=conversation.getClientRects().length>0;
    const gap=conversation.scrollHeight-conversation.scrollTop-conversation.clientHeight;
    button.hidden=!visible||gap<=160;
    if(button.hidden)return;
    const viewport=conversation.getBoundingClientRect(),container=parent.getBoundingClientRect();
    button.style.left=(viewport.right-container.left-button.offsetWidth/2-12)+'px';
    button.style.bottom=Math.max(12,container.bottom-viewport.bottom+12)+'px';
  }
  function schedule(){if(frame===null)frame=window.requestAnimationFrame(update);}
  button.addEventListener('click',()=>{
    const preference=document.documentElement.dataset.reducedMotion;
    const reduced=preference==='true'||preference!=='false'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    conversation.scrollTo({top:conversation.scrollHeight,behavior:reduced?'auto':'smooth'});
    conversation.focus({preventScroll:true});
  });
  conversation.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule);
  const resize=new window.ResizeObserver(schedule);resize.observe(conversation);
  const mutation=new window.MutationObserver(schedule);
  mutation.observe(conversation,{childList:true,subtree:true,characterData:true});
  mutation.observe(parent,{attributes:true,attributeFilter:['class','hidden']});
  schedule();
  return {update:schedule,button,destroy(){
    if(frame!==null)window.cancelAnimationFrame(frame);
    conversation.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);
    resize.disconnect();mutation.disconnect();button.remove();if(!hadAnchor)parent.classList.remove('scroll-button-host');
  }};
}
