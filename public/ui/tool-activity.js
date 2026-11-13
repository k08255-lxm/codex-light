import { renderActivityRecord, renderCompactionRecord, itemState, describeItem } from '../activity-feed.js';
import { icon } from '../icons.js';

const OPERATIONS = new Set(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','functionCallOutput','webSearch',
  'collabAgentToolCall','subAgentActivity','fileDiff','reasoning','plan','imageView','imageGeneration']);

export function mountToolActivity(host, { document = host.ownerDocument, artifacts = null } = {}) {
  const views = new Map(), expanded = new Set();
  let scope = null;
  function releaseRow(row) { for (const strip of row.details.querySelectorAll('.artifact-strip')) strip.release?.(); }
  function releaseView(view) { for (const row of view.rows.values()) releaseRow(row); }
  function node(tag, className, text) {
    const value = document.createElement(tag);
    value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  }
  function remember(details, key) {
    details.open = expanded.has(key);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) expanded.add(key); else expanded.delete(key);
    });
  }
  function reconcile(parent, children) {
    const keep = new Set(children);
    for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
    children.forEach((child, index) => { if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null); });
  }
  function render(items, nextScope) {
    if (scope !== nextScope) { scope = nextScope; for (const view of views.values()) releaseView(view); views.clear(); expanded.clear(); host.replaceChildren(); }
    const groups = [];
    let group = null, turnId = null;
    for (const item of Array.isArray(items) ? items : []) {
      if (['agentMessage','userMessage'].includes(item.type) || (item._turnId && turnId && item._turnId !== turnId)) { if(group)group.closed=true;group = null; }
      if (item._turnId) turnId = item._turnId;
      if (item.type === 'contextCompaction') { if(group)group.closed=true; group=null; groups.push({key:item.id,items:[item],compaction:true}); continue; }
      if (!OPERATIONS.has(item.type)) continue;
      if (!group) { group = { key: item.id, items: [] }; groups.push(group); }
      group.items.push(item);
    }
    const shown = [], keep = new Set(), children = [];
    let remaining=100;
    for(const group of groups.slice(-25).reverse()){
      if(!remaining)break;
      const visible=group.items.slice(-remaining);remaining-=visible.length;
      shown.unshift({...group,visible});
    }
    for (const group of shown) {
      if(group.compaction){children.push(renderCompactionRecord(document,group.items[0]));continue;}
      keep.add(group.key);
      let view = views.get(group.key);
      if (!view) {
        const details = node('details','agent-operation-group tool-operation-group');
        const summary = node('summary','agent-operation-summary');
        const label = node('span',''), latest = node('span','agent-operation-latest');
        summary.append(label, latest, icon(document,'down',{size:14}));
        const list = node('div','agent-operation-items'); details.append(summary,list);
        remember(details,`group:${group.key}`);
        view = { details, label, latest, list, rows: new Map() }; views.set(group.key,view);
      }
      const running = !group.closed && group.items.some(item => itemState(item) === 'running');
      view.details.dataset.running = String(running);
      const failed = group.items.some(item => itemState(item) === 'failed');
      view.label.textContent = `${group.items.length} 项操作${running?' · 运行中':failed?' · 含失败操作':''}${group.visible.length<group.items.length?` · 最近 ${group.visible.length} 项`:''}`;
      const description = describeItem(group.items.at(-1));
      view.latest.textContent = running ? description.verb : '';
      view.latest.hidden = !running;
      const rows = [], rowIds = new Set();
      for (const item of group.visible) {
        rowIds.add(item.id);
        let row = view.rows.get(item.id);
        if (!row || row.item !== item) {
          if(row)releaseRow(row);
          const details = renderActivityRecord(document,item,{artifacts});
          remember(details,`item:${item.id}`); row = {item,details}; view.rows.set(item.id,row);
        }
        row.details.dataset.running = String(running && itemState(item) === 'running');
        rows.push(row.details);
      }
      for (const id of view.rows.keys()) if (!rowIds.has(id)) { releaseRow(view.rows.get(id)); view.rows.delete(id); }
      reconcile(view.list,rows); children.push(view.details);
    }
    for (const key of views.keys()) if (!keep.has(key)) { releaseView(views.get(key)); views.delete(key); }
    if (!children.length) children.push(node('p','muted','暂无工具活动'));
    reconcile(host,children);
  }
  return { render };
}
