/** User-driven upward paging. Never drains history in response to its own DOM/scroll changes. */
export function mountHistoryAutoLoad({container, button, status, canLoad, load, getKey}) {
  let pending = null, failed = false, lastTop = container.scrollTop, touchY = null, epoch = 0;
  const label = '加载更早的内容';
  function reset() { epoch++; pending = null; failed = false; button.disabled = false; button.textContent = label; status.textContent = ''; lastTop = container.scrollTop; }
  async function request(manual = false) {
    if (pending || (!manual && failed) || !canLoad()) return;
    const key = getKey(), version = epoch;
    const ticket = {}; pending = ticket; failed = false; button.disabled = true;
    button.textContent = '正在加载…'; status.textContent = '正在加载更早的内容…';
    try {
      await load();
      if (key !== getKey() || version !== epoch) return;
      status.textContent = canLoad() ? '' : '已到对话开头';
      button.textContent = label;
    } catch (error) {
      if (key !== getKey() || version !== epoch) return;
      failed = true; button.textContent = '重试加载更早的内容';
      status.textContent = '加载失败：' + (error?.message || '请重试');
    } finally {
      if (pending === ticket) { pending = null; button.disabled = false; lastTop = container.scrollTop; }
    }
  }
  const nearTop = () => container.scrollTop <= 180;
  container.addEventListener('scroll', () => { const top=container.scrollTop; const upward=top<lastTop;lastTop=top;if(upward&&nearTop())void request(); }, {passive:true});
  // At scrollTop=0 a wheel/touch/keyboard attempt emits no scroll event.
  container.addEventListener('wheel', e => {if(e.deltaY<0&&nearTop())void request();},{passive:true});
  container.addEventListener('touchstart',e=>{touchY=e.touches?.[0]?.clientY??null;},{passive:true});
  container.addEventListener('touchmove',e=>{const y=e.touches?.[0]?.clientY;if(touchY!==null&&y>touchY+12&&nearTop()){touchY=y;void request();}},{passive:true});
  container.addEventListener('keydown',e=>{if(['ArrowUp','PageUp','Home'].includes(e.key)&&nearTop()&&!e.target?.closest?.('input,textarea,[contenteditable="true"]'))void request();});
  button.addEventListener('click',()=>void request(true));
  return {reset, request};
}
export function captureHistoryAnchor(container, selectors = ['[data-item-id]', '[data-turn-id]']) {
  const top=container.getBoundingClientRect().top;
  const node=selectors.flatMap(selector=>[...container.querySelectorAll(selector)]).find(node=>node.getBoundingClientRect().bottom>top&&node.getBoundingClientRect().height>0);
  return {node, offset:node?node.getBoundingClientRect().top-top:0, scrollTop:container.scrollTop};
}
export function restoreHistoryAnchor(container,anchor) {
  if(anchor?.node&&container.contains(anchor.node))container.scrollTop+=anchor.node.getBoundingClientRect().top-container.getBoundingClientRect().top-anchor.offset;
  else if(anchor)container.scrollTop=anchor.scrollTop;
}
/** Downward list paging with a manual fallback. Status belongs to the scroll content, not the dock. */
export function mountThreadAutoLoad({container,button,status,canLoad,load,getKey}) {
  let pending=null, failed=false, epoch=0, lastTop=container.scrollTop;
  function reset(){epoch++;pending=null;failed=false;status.textContent='';button.disabled=false;button.textContent='加载更多对话';lastTop=container.scrollTop;}
  async function request(manual=false){
    if(pending||(!manual&&failed)||!canLoad())return;
    const ticket={},version=epoch,key=getKey();pending=ticket;button.disabled=true;button.textContent='正在加载…';status.textContent='正在加载更多对话…';
    try{await load();if(version!==epoch||key!==getKey())return;failed=false;button.textContent='加载更多对话';status.textContent=canLoad()?'':'已加载全部对话';}
    catch(e){if(version!==epoch||key!==getKey())return;failed=true;button.textContent='重试加载对话';status.textContent='加载失败：'+(e?.message||'请重试');}
    finally{if(pending===ticket){pending=null;button.disabled=false;lastTop=container.scrollTop;}}
  }
  const bottom=()=>container.scrollHeight-container.clientHeight-container.scrollTop<=180;
  container.addEventListener('scroll',()=>{const top=container.scrollTop,down=top>lastTop;lastTop=top;if(down&&bottom())void request();},{passive:true});
  container.addEventListener('wheel',e=>{if(e.deltaY>0&&bottom())void request();},{passive:true});
  let y=null;
  container.addEventListener('touchstart',e=>{y=e.touches?.[0]?.clientY??null;},{passive:true});
  container.addEventListener('touchmove',e=>{const next=e.touches?.[0]?.clientY;if(y!==null&&next<y-12&&bottom()){y=next;void request();}},{passive:true});
  container.addEventListener('keydown',e=>{if(['ArrowDown','PageDown','End'].includes(e.key)&&bottom())void request();});
  button.addEventListener('click',()=>void request(true));
  return {reset,request};
}
