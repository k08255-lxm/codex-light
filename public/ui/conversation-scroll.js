const EPSILON = 2;
const blocks = 'p,pre,li,h1,h2,h3,h4,h5,h6,blockquote,table,fieldset,summary';

function pathFrom(root, node) {
  const path = [];
  while (node && node !== root) { const parent = node.parentElement; if (!parent) return null; path.unshift([...parent.children].indexOf(node)); node = parent; }
  return node === root ? path : null;
}
function visible(node, top, height) { const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > top && rect.top < top + height; }

// One authority for follow intent. Layout changes must never re-enable following.
export function mountConversationScroll(container) {
  const document = container.ownerDocument, window = document.defaultView;
  const transcript = container.querySelector('#messages');
  const originalAnchor = container.style.overflowAnchor; container.style.overflowAnchor = 'none';
  let following = true, saved = null, frame = null, writing = null, lastTop = container.scrollTop;
  let disclosure = null, sampleTimer = null;
  let userUntil = 0, userDirection = 0, touchY = null, layoutPending = false, smoothUntil = 0, destroyed = false;
  const gap = () => container.scrollHeight - container.scrollTop - container.clientHeight;
  function capture() {
    const viewport = container.getBoundingClientRect(), top = viewport.top;
    if (disclosure && container.contains(disclosure.node)) {
      return {following:false, top:container.scrollTop, node:disclosure.node, offset:disclosure.offset};
    }
    disclosure = null;
    const turnSelector = '[data-turn-id],[data-virtual-turn-id]';
    const column = transcript?.getBoundingClientRect();
    const x = column ? (Math.max(viewport.left,column.left)+Math.min(viewport.right,column.right))/2 : viewport.left+viewport.width/2;
    const hit = document.elementsFromPoint?.(x,top+1).find(node=>transcript?.contains(node) && node.closest(turnSelector));
    let turn = hit?.closest(turnSelector);
    if (!turn && transcript?.children.length) {
      // Gaps between messages have no hit target. Probe ordered turn boxes, including virtual ones.
      const rows=transcript.children;
      let first=0,end=rows.length;
      while(first<end){const mid=(first+end)>>>1;if(rows[mid].getBoundingClientRect().bottom<=top)first=mid+1;else end=mid;}
      if(first<rows.length && visible(rows[first],top,viewport.height))turn=rows[first];
    }
    const item = hit?.closest('[data-item-id]') || Array.from(turn?.querySelectorAll('[data-item-id]')||[]).find(node=>visible(node,top,viewport.height));
    const hitBlock=hit?.closest(blocks);
    const leaf = item && (item.contains(hitBlock) ? hitBlock : Array.from(item.querySelectorAll(blocks)).find(node=>visible(node,top,viewport.height)));
    const node = leaf || item || turn;
    return { following, top: container.scrollTop, node, itemId: item?.dataset.itemId,
      turnId: turn?.dataset.turnId || turn?.dataset.virtualTurnId, path: item && node ? pathFrom(item, node) : null,
      tag: node?.tagName, prefix: leaf?.textContent?.slice(0, 80), offset: node ? node.getBoundingClientRect().top - top : 0,
      itemOffset: item ? item.getBoundingClientRect().top - top : 0, turnOffset: turn ? turn.getBoundingClientRect().top - top : 0 };
  }
  function write(top) {
    if (Math.abs(container.scrollTop - top) < 0.5) return;
    container.scrollTop = top; writing = container.scrollTop; lastTop = container.scrollTop;
  }
  function restore(snapshot = saved, { follow = true, preserveMotion = false } = {}) {
    if (destroyed || !snapshot || !container.getClientRects().length) return;
    if (follow && following && snapshot.following) write(container.scrollHeight);
    else {
      const top = container.getBoundingClientRect().top;
      const item = snapshot.itemId && (!snapshot.node || !container.contains(snapshot.node) || !snapshot.node.getBoundingClientRect().height)
        ? [...container.querySelectorAll('[data-item-id]')].find(node => node.dataset.itemId === snapshot.itemId) : null;
      let node = snapshot.node && container.contains(snapshot.node) ? snapshot.node : null, offset = snapshot.offset;
      if (!node && item && snapshot.path) {
        node = snapshot.path.reduce((parent, index) => parent?.children[index], item);
        if (node?.tagName !== snapshot.tag || snapshot.prefix && !node.textContent.startsWith(snapshot.prefix)) node = null;
      }
      if (!node && item && snapshot.prefix) node = [...item.querySelectorAll(blocks)].find(value => value.tagName === snapshot.tag && value.textContent.startsWith(snapshot.prefix));
      if (!node || !node.getBoundingClientRect().height) { node = item; offset = snapshot.itemOffset; }
      if (!node || !node.getBoundingClientRect().height) {
        node = [...container.querySelectorAll('[data-turn-id],[data-virtual-turn-id]')].find(value => (value.dataset.turnId || value.dataset.virtualTurnId) === snapshot.turnId);
        offset = snapshot.turnOffset;
      }
      // A wheel or touch delta may have landed between observation and this frame.
      // Compensate only for layout that moved the anchor in content coordinates.
      const motion = preserveMotion && Date.now() < userUntil ? container.scrollTop - snapshot.top : 0;
      if (node?.getBoundingClientRect().height) write(container.scrollTop + node.getBoundingClientRect().top - top - offset + motion);
      else if (!preserveMotion) write(snapshot.top);
    }
    saved = capture(); layoutPending = false;
  }
  function schedule() {
    if (destroyed) return;
    layoutPending = true;
    if (frame === null) frame = window.requestAnimationFrame(() => { frame = null; restore(saved, {preserveMotion:true}); });
  }
  function pause(control, { keepVisible = true } = {}) {
    if (smoothUntil > Date.now()) container.scrollTo({ top:container.scrollTop, behavior:'instant' });
    following = false; smoothUntil = 0; userUntil = 0; disclosure = null;
    if (control) {
      // A sticky summary's painted top stops moving with scrollTop. Restore against
      // its details element in normal flow, including when closing from a sticky header.
      const node = control.classList.contains('turn-work-summary') ? control.parentElement : control;
      const offset = control.getBoundingClientRect().top - container.getBoundingClientRect().top;
      disclosure = {node, offset:keepVisible ? Math.max(0, Math.min(container.clientHeight - control.offsetHeight, offset)) : offset};
    }
    saved = capture();
  }
  function intent(up) {
    disclosure = null;
    if (up && following) pause();
    userUntil = Date.now() + 600; userDirection = up ? -1 : 1;
  }
  const wheel = event => { if (event.deltaY) intent(event.deltaY < 0); };
  const keydown = event => {
    if (event.key === 'Tab' && disclosure) pause();
    if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]') || event.key === ' ' && event.target?.closest?.('summary,button')) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) intent(true);
    else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) intent(false);
  };
  const touchstart = event => { touchY = event.touches?.[0]?.clientY ?? null; };
  const touchmove = event => { const next = event.touches?.[0]?.clientY; if (touchY !== null && Number.isFinite(next)) { intent(next > touchY); touchY = next; } };
  const pointerdown = event => {
    // Clicking a disclosure can clamp scrollTop during collapse. Only an actual
    // scrollbar gesture (or middle-button autoscroll) counts as scrolling intent.
    if (event.button !== 1 && !(event.target === container && event.offsetX >= container.clientWidth)) return;
    disclosure = null; userUntil = Date.now() + 600; userDirection = 0;
  };
  function scroll() {
    const top = container.scrollTop, user = Date.now() < userUntil;
    if (writing !== null && Math.abs(top - writing) < EPSILON) { writing = null; lastTop = top; return; }
    if (!user && Date.now() < smoothUntil) { lastTop = top; if (gap() <= EPSILON) saved = capture(); return; }
    if (user || !layoutPending && Math.abs(top - lastTop) >= EPSILON) {
      if (user && userDirection >= 0 && gap() <= EPSILON && top >= lastTop) following = true;
      else if (gap() > EPSILON || user && userDirection < 0) following = false;
      if(user){
        // The native scroll owns the gesture. Sample the reading anchor at most twice
        // a second, then take the final sample when momentum actually stops.
        sampleTimer ??= window.setTimeout(samplePosition,500);
      }else saved = capture();
      writing = null;
    }
    lastTop = top;
  }
  function samplePosition(){
    if(sampleTimer===null)return;
    window.clearTimeout(sampleTimer);sampleTimer=null;
    if(!layoutPending)saved=capture();
  }
  function toBottom({ behavior = 'auto' } = {}) {
    disclosure = null; following = true; userUntil = 0; smoothUntil = behavior === 'smooth' ? Date.now() + 1200 : 0;
    if (behavior === 'smooth') container.scrollTo({ top: container.scrollHeight, behavior });
    else write(container.scrollHeight);
    saved = capture();
  }
  container.addEventListener('scroll', scroll, { passive: true });
  container.addEventListener('scrollend', samplePosition, {passive:true});
  container.addEventListener('wheel', wheel, { passive: true }); container.addEventListener('keydown', keydown);
  container.addEventListener('touchstart', touchstart, { passive: true }); container.addEventListener('touchmove', touchmove, { passive: true });
  container.addEventListener('pointerdown', pointerdown, { passive: true });
  const resize = new window.ResizeObserver(schedule), observed = new Set();
  function observeChildren() {
    for (const node of observed) if (node !== container && node.parentElement !== container) { resize.unobserve(node); observed.delete(node); }
    for (const node of [container, ...container.children]) if (!observed.has(node)) { resize.observe(node); observed.add(node); }
  }
  const mutation = new window.MutationObserver(() => { observeChildren(); schedule(); });
  mutation.observe(container, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open', 'class', 'style', 'hidden'] });
  observeChildren(); saved = capture();
  return { capture, restore, toBottom, pause, get following() { return following; }, get atBottom() { return gap() <= EPSILON; }, destroy() {
    destroyed = true; if (frame !== null) window.cancelAnimationFrame(frame); window.clearTimeout(sampleTimer);container.removeEventListener('scrollend',samplePosition);resize.disconnect(); mutation.disconnect();
    for (const [name, listener] of [['scroll', scroll], ['wheel', wheel], ['keydown', keydown], ['touchstart', touchstart], ['touchmove', touchmove], ['pointerdown', pointerdown]]) container.removeEventListener(name, listener);
    container.style.overflowAnchor = originalAnchor;
  } };
}
