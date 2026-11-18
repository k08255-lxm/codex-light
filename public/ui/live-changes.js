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
  const turn = [...list].reverse().find(row => row.status==='running') || [...list].reverse().find(row=>row.files?.count) || null;
  if (!turn?.files?.count) return { count: 0, rows: [], running: false, added: null, removed: null, turnId: turn?.id||null };
  // Files whose net change in this turn is zero (e.g. edited then restored) are not "changed".
  const rows = turn.files.rows.filter(row => row.net !== 'unchanged');
  return {...summarizeFileRows(rows,turn.status==='running'),turnId:turn.id};
}

export function mountLiveChanges(host, { renderDiff }) {
  const document = host.ownerDocument;
  const pill = el(document, 'button', 'changes-pill'); pill.type = 'button'; pill.setAttribute('aria-expanded', 'false'); pill.setAttribute('aria-controls', 'changes-panel');
  const panel = el(document, 'section', 'changes-panel hidden'); panel.id = 'changes-panel'; panel.setAttribute('aria-label', '本轮已更改的文件');
  host.append(pill, panel);
  let summary = { count: 0, rows: [] }; let open = false; const expanded = new Set(); let scope = null;
  const rows = new Map();
  const head = el(document, 'div', 'changes-head'), heading = el(document, 'strong'), totals = el(document, 'span');
  const close = el(document, 'button', 'btn icon-only'); close.type = 'button'; close.setAttribute('aria-label', '关闭'); close.append(icon(document, 'close', { size: 14 }));
  close.addEventListener('click', () => { open = false; draw(); pill.focus(); });
  head.append(heading, totals, close);
  const list = el(document, 'ul', 'changes-list'); panel.append(head, list);
  pill.addEventListener('click', () => { open = !open; draw(); });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); open = false; draw(); pill.focus(); } });
  document.addEventListener('click',event=>{if(open&&!host.contains(event.target)&&!event.composedPath?.().includes(host)){open=false;draw();}});
  const stats = evidence => statsNode(document,evidence.added,evidence.removed,evidence);
  function draw() {
    host.classList.toggle('hidden', !summary.count);
    if (!summary.count) { open = false; panel.classList.add('hidden'); pill.setAttribute('aria-expanded','false'); return; }
    pill.replaceChildren(icon(document, 'diff', { size: 14 }), el(document, 'span', 'pill-text', `${summary.count} 个文件${summary.running ? '正在更改' : '已更改'}`), stats(summary));
    pill.dataset.running = String(!!summary.running);
    pill.setAttribute('aria-expanded', String(open));
    panel.classList.toggle('hidden', !open);
    if (!open) return;
    const panelTop=panel.scrollTop, listTop=list.scrollTop;
    heading.textContent = summary.running ? '本轮正在更改的文件' : '最近一轮更改的文件'; totals.replaceChildren(stats(summary));
    const retained = new Set();
    let position = 0;
    for (const row of summary.rows) {
      retained.add(row.path);
      let view=rows.get(row.path);
      if(!view){
        const node=el(document,'li','changes-row'),button=el(document,'button','changes-file');button.type='button';
        button.addEventListener('click',()=>{if(expanded.has(row.path))expanded.delete(row.path);else expanded.add(row.path);draw();});
        node.append(button);view={node,button,diff:null,source:null,label:null};rows.set(row.path,view);
      }
      const label=JSON.stringify([row.path,row.fullPath,row.added,row.removed,row.knownAdded,row.knownRemoved,row.knownEdits,row.complete,row.unknownCount,row.statsReasons,row.known]);
      if(view.label!==label){
        const slash=row.path.lastIndexOf('/');view.button.title=row.fullPath;
        view.button.replaceChildren(el(document,'span','file-dir',slash>=0?row.path.slice(0,slash+1):''),el(document,'span','file-base',slash>=0?row.path.slice(slash+1):row.path),stats(row));view.label=label;
      }
      const shown=expanded.has(row.path);view.button.setAttribute('aria-expanded',String(shown));
      const source=row.diffs.join('\n');
      if(shown&&(!view.diff||view.source!==source)){
        const top=view.diff?.scrollTop||0,left=view.diff?.scrollLeft||0;
        const next=row.diffs.length?renderDiff(document,source):el(document,'p','diff-empty','没有可显示的差异内容。');
        if(view.diff)view.diff.replaceWith(next);else view.node.append(next);
        view.diff=next;view.source=source;next.scrollTop=top;next.scrollLeft=left;
      }
      if(view.diff)view.diff.hidden=!shown;
      // Keep unchanged nodes attached: progress ticks must not reset diff scrolling or selection.
      if(list.children[position]!==view.node)list.insertBefore(view.node,list.children[position]||null);
      position++;
    }
    for(const [path,view] of rows)if(!retained.has(path)){view.node.remove();rows.delete(path);expanded.delete(path);}
    panel.scrollTop=panelTop;list.scrollTop=listTop;
  }
  return { update(next, threadId = null) { const key=JSON.stringify([threadId,next.turnId]);if(scope!==key){scope=key;open=false;expanded.clear();rows.clear();list.replaceChildren();panel.scrollTop=0;list.scrollTop=0;}summary = next; draw(); }, close() { open = false; draw(); }, isOpen: () => open };
}

/** Explicitly returning to the bottom resumes following when a controller is supplied. */
export function mountScrollToBottom(conversation, { onBottom = null } = {}) {
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
    if(onBottom)onBottom(reduced?'auto':'smooth');
    else conversation.scrollTo({top:conversation.scrollHeight,behavior:reduced?'auto':'smooth'});
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
