/** Serialize upward paging and optional background fill for the active conversation. */
export function mountHistoryAutoLoad({container, button, status, canLoad, load, getKey,scrollController=null,autoFill=false, incompleteTurn=()=>false,label='加载更早的内容',endLabel='已到对话开头'}) {
  let pending = null, failed = false, lastTop = container.scrollTop, touchY = null, epoch = 0;
  let upwardUntil = 0, fillTimer = null;
  const needsContent = () => incompleteTurn() || container.scrollHeight <= container.clientHeight + 1;
  function fill() {
    if (!autoFill || fillTimer!==null || pending || failed || !canLoad() || !needsContent()) return;
    // Let the newest page paint and give input a turn between history batches.
    fillTimer=setTimeout(()=>{fillTimer=null;if(needsContent())void request(false,true);},80);
  }
  // Loading/error text is inside the scroller. Preserve the reading position when
  // it enters/leaves flow, including at scrollTop=0 where native anchoring is off.
  function feedback(change) {
    const anchor = scrollController ? scrollController.capture() : captureHistoryAnchor(container);
    change();
    if (scrollController) scrollController.restore(anchor, {follow:false});
    else restoreHistoryAnchor(container, anchor);
  }
  function reset() { epoch++; clearTimeout(fillTimer);fillTimer=null; upwardUntil = 0; pending = null; failed = false; button.disabled = false; button.ariaBusy = 'false'; button.textContent = label; status.textContent = ''; lastTop = container.scrollTop; }
  async function request(manual = false, background = false) {
    if (pending || (!manual && failed) || !canLoad()) return;
    const key = getKey(), version = epoch;
    if (!background) scrollController?.pause();
    const ticket = {}; pending = ticket; failed = false; button.disabled = true;
    feedback(() => { button.ariaBusy = 'true'; button.textContent = label; status.textContent = ''; });
    try {
      await load();
      if (key !== getKey() || version !== epoch) return;
      feedback(() => { status.textContent = canLoad() ? '' : endLabel; button.textContent = label; });
    } catch (error) {
      if (key !== getKey() || version !== epoch) return;
      failed = true; feedback(() => { button.textContent = '重试'+label; status.textContent = '加载失败：' + (error?.message || '请重试'); });
    } finally {
      if (pending === ticket) { pending = null; button.disabled = false; button.ariaBusy = 'false'; lastTop = container.scrollTop;fill(); }
    }
  }
  // Start the next page before a continuous gesture reaches the hard top.
  const nearTop = () => container.scrollTop <= Math.max(180, container.clientHeight || 0);
  function upward() { upwardUntil=Date.now()+700;if(nearTop())void request(); }
  container.addEventListener('scroll', () => {
    const top=container.scrollTop, movedUp=top<lastTop;lastTop=top;
    if(movedUp && Date.now()<upwardUntil)upward();
  }, {passive:true});
  container.addEventListener('wheel', e => { if(e.deltaY<0)upward();else if(e.deltaY>0)upwardUntil=0; },{passive:true});
  container.addEventListener('touchstart',e=>{touchY=e.touches?.[0]?.clientY??null;},{passive:true});
  container.addEventListener('touchmove',e=>{const y=e.touches?.[0]?.clientY;if(touchY!==null&&Number.isFinite(y)){if(y>touchY)upward();else if(y<touchY)upwardUntil=0;}touchY=y;},{passive:true});
  container.addEventListener('pointerdown',e=>{if(e.target===container&&e.offsetX>=container.clientWidth)upwardUntil=Infinity;});
  container.addEventListener('pointerup',()=>{if(upwardUntil===Infinity)upwardUntil=Date.now()+700;});
  container.addEventListener('keydown',e=>{if(['ArrowUp','PageUp','Home'].includes(e.key)&&!e.target?.closest?.('input,textarea,[contenteditable="true"]'))upward();});
  button.addEventListener('click',()=>void request(true));
  return {reset, request, fill};
}
export function captureHistoryAnchor(container, selectors = ['[data-item-id]', '[data-turn-id]', '[data-virtual-turn-id]']) {
  const top=container.getBoundingClientRect().top;
  const node=selectors.flatMap(selector=>[...container.querySelectorAll(selector)]).find(node=>node.getBoundingClientRect().bottom>top&&node.getBoundingClientRect().top<top+(container.clientHeight||Infinity)&&node.getBoundingClientRect().height>0);
  return {node, itemId:node?.dataset?.itemId, turnId:node?.dataset?.turnId||node?.dataset?.virtualTurnId, offset:node?node.getBoundingClientRect().top-top:0, scrollTop:container.scrollTop};
}
export function restoreHistoryAnchor(container,anchor) {
  const node=anchor?.node&&container.contains(anchor.node)?anchor.node:anchor?.itemId?[...container.querySelectorAll('[data-item-id]')].find(n=>n.dataset.itemId===anchor.itemId):anchor?.turnId?[...container.querySelectorAll('[data-turn-id], [data-virtual-turn-id]')].find(n=>(n.dataset.turnId||n.dataset.virtualTurnId)===anchor.turnId):null;
  if(node)container.scrollTop+=node.getBoundingClientRect().top-container.getBoundingClientRect().top-anchor.offset;
  else if(anchor)container.scrollTop=anchor.scrollTop;
}
/** Downward list paging with a manual fallback. Status belongs to the scroll content, not the dock. */
export function mountThreadAutoLoad({container,button,status,canLoad,load,getKey}) {
  let pending=null, failed=false, epoch=0, lastTop=container.scrollTop;
  function reset(){epoch++;pending=null;failed=false;status.textContent='';button.disabled=false;button.ariaBusy='false';button.textContent='加载更多对话';lastTop=container.scrollTop;}
  async function request(manual=false){
    if(pending||(!manual&&failed)||!canLoad())return;
    const ticket={},version=epoch,key=getKey();pending=ticket;button.disabled=true;button.ariaBusy='true';button.textContent='加载更多对话';status.textContent='';
    try{await load();if(version!==epoch||key!==getKey())return;failed=false;button.textContent='加载更多对话';status.textContent=canLoad()?'':'已加载全部对话';}
    catch(e){if(version!==epoch||key!==getKey())return;failed=true;button.textContent='重试加载对话';status.textContent='加载失败：'+(e?.message||'请重试');}
    finally{if(pending===ticket){pending=null;button.disabled=false;button.ariaBusy='false';lastTop=container.scrollTop;}}
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
