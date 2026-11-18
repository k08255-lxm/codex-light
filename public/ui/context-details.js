import {contextFields,contextView} from '../context-usage.js';

export function mountContextDetails(document) {
  const meter = document.getElementById('context-meter');
  const label = document.getElementById('context-label');
  const dialog = document.getElementById('context-details');
  const closeButton = document.getElementById('context-details-close');
  const status = document.getElementById('context-details-status');
  const format = new Intl.NumberFormat('zh-CN');
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
  const lastRows = addMetrics('context-last-metrics',contextFields);
  const totalRows = addMetrics('context-total-metrics',contextFields);
  function setRows(rows, values) {
    for(const [key,node] of rows){
      const value=values?.[key];
      node.textContent=value==null?'未知':format.format(value);
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
    if(!dialog.open)return;
    status.textContent=loading&&!snapshot?'正在读取此对话的上下文用量…':!snapshot?'此对话暂无可用用量记录。':
      snapshot.source==='history'?'来自该对话的最近一条历史用量记录。':'来自 Codex 最近一次用量更新。';
    setRows(windowRows,{used:snapshot?.used,remaining:view.remaining,window:snapshot?.window});
    setRows(lastRows,snapshot?.last);
    setRows(totalRows,snapshot?.total);
  }
  function close(){if(dialog.open)dialog.close();}
  meter.addEventListener('click',()=>{
    if(!threadId||dialog.open)return;
    dialog.showModal();meter.setAttribute('aria-expanded','true');draw();closeButton.focus();
  });
  closeButton.addEventListener('click',close);
  dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
  dialog.addEventListener('close',()=>{
    meter.setAttribute('aria-expanded','false');
    if(threadId&&meter.getClientRects().length)meter.focus({preventScroll:true});
  });
  return {close,update(id, next, pending=false){
    if(threadId!==id)close();
    threadId=id;snapshot=next;loading=pending;draw();
  }};
}
