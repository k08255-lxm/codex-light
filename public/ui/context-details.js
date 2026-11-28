import {contextFields,contextView} from '../context-usage.js';
import {mountStatPopover} from './stat-popover.js';
import {showTokens} from './format.js';

export function mountContextDetails(document) {
  const meter = document.getElementById('context-meter');
  const label = document.getElementById('context-label');
  const dialog = document.getElementById('context-details');
  const closeButton = document.getElementById('context-details-close');
  const status = document.getElementById('context-details-status');
  let threadId = null, snapshot = null, loading = false;
  function addMetrics(id, fields) {
    const host = document.getElementById(id);
    return fields.map(([field,title]) => {
      const row = document.createElement('div');
      const name = document.createElement('dt'), value = document.createElement('dd');
      name.textContent = title;
      value.dataset.metric = field;
      row.append(name, value);host.append(row);
      return [field,value];
    });
  }
  const windowRows = addMetrics('context-window-metrics',[['used','已用'],['remaining','剩余'],['window','窗口']]);
  const lastRows=[],totalRows=[];
  for(const [field,title] of contextFields){
    const row=document.createElement('tr'),name=document.createElement('th');
    name.scope='row';name.textContent=title;row.append(name);
    for(const [scope,rows] of [['last',lastRows],['total',totalRows]]){
      const value=document.createElement('td');value.dataset.scope=scope;value.dataset.metric=field;
      rows.push([field,value]);row.append(value);
    }
    document.getElementById('context-breakdown').append(row);
  }
  function setRows(rows, values) {
    for(const [key,node] of rows){
      const value=values?.[key];
      showTokens(node,value,{unknown:'未知'});
      node.dataset.known=String(value!=null);
    }
  }
  function draw() {
    const view=contextView(snapshot);
    meter.dataset.known=String(view.known);
    meter.style.setProperty('--ctx-used',String(view.percentUsed??0));
    meter.dataset.level=!view.known?'unknown':view.percentLeft<=10?'low':view.percentLeft<=25?'warn':'ok';
    label.textContent=view.known?view.label:'—';
    meter.title=view.detail;
    meter.setAttribute('aria-label',view.detail+'，查看上下文详情');
    meter.classList.toggle('hidden',!threadId);
    if(!popover.open)return;
    status.textContent=loading&&!snapshot?'正在读取此对话的上下文用量…':!snapshot?'此对话暂无可用用量记录。':
      snapshot.source==='history'?'来自该对话的最近一条历史用量记录。':'来自 Codex 最近一次用量更新。';
    setRows(windowRows,{used:snapshot?.used,remaining:view.remaining,window:snapshot?.window});
    setRows(lastRows,snapshot?.last);
    setRows(totalRows,snapshot?.total);
  }
  const popover=mountStatPopover(meter,dialog,{onOpen:draw,focusOnOpen:closeButton});
  closeButton.addEventListener('click',()=>popover.close(true));
  return {close:popover.close,get open(){return popover.open;},update(id, next, pending=false){
    if(threadId!==id)popover.close();
    threadId=id;snapshot=next;loading=pending;draw();
  }};
}
