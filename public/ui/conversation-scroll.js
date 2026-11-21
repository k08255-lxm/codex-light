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
  const originalAnchor = container.style.overflowAnchor; container.style.overflowAnchor = 'none';
  let following = true, saved = null, frame = null, writing = null, lastTop = container.scrollTop;
  let userUntil = 0, userDirection = 0, touchY = null, layoutPending = false, smoothUntil = 0, destroyed = false;
  const gap = () => container.scrollHeight - container.scrollTop - container.clientHeight;
  function capture() {
    const top = container.getBoundingClientRect().top;
    const item = [...container.querySelectorAll('[data-item-id]')].find(node => visible(node, top, container.clientHeight));
    const turn = item?.closest('[data-turn-id]') || [...container.querySelectorAll('[data-turn-id],[data-virtual-turn-id]')].find(node => visible(node, top, container.clientHeight));
    const leaf = item && [...item.querySelectorAll(blocks)].find(node => visible(node, top, container.clientHeight));
    const node = leaf || item || turn;
    return { following, top: container.scrollTop, node, itemId: item?.dataset.itemId,
      turnId: turn?.dataset.turnId || turn?.dataset.virtualTurnId, path: item && node ? pathFrom(item, node) : null,
      tag: node?.tagName, prefix: leaf?.textContent?.slice(0, 80), offset: node ? node.getBoundingClientRect().top - top : 0,
      itemOffset: item ? item.getBoundingClientRect().top - top : 0, turnOffset: turn ? turn.getBoundingClientRect().top - top : 0 };
  }
  function write(top) {
    container.scrollTop = top; writing = container.scrollTop; lastTop = container.scrollTop;
  }
  function restore(snapshot = saved, { follow = true } = {}) {
    if (destroyed || !snapshot || !container.getClientRects().length) return;
    if (follow && following && snapshot.following) write(container.scrollHeight);
    else {
      const top = container.getBoundingClientRect().top;
      const item = snapshot.itemId && [...container.querySelectorAll('[data-item-id]')].find(node => node.dataset.itemId === snapshot.itemId);
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
      write(node?.getBoundingClientRect().height ? container.scrollTop + node.getBoundingClientRect().top - top - offset : snapshot.top);
    }
    saved = capture(); layoutPending = false;
  }
  function schedule() {
    if (destroyed) return;
    layoutPending = true;
    if (frame === null) frame = window.requestAnimationFrame(() => { frame = null; restore(saved); });
  }
  function pause() { following = false; smoothUntil = 0; saved = capture(); }
  function intent(up) { userUntil = Date.now() + 600; userDirection = up ? -1 : 1; if (up) pause(); }
  const wheel = event => { if (event.deltaY) intent(event.deltaY < 0); };
  const keydown = event => {
    if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) intent(true);
    else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) intent(false);
  };
  const touchstart = event => { touchY = event.touches?.[0]?.clientY ?? null; };
  const touchmove = event => { const next = event.touches?.[0]?.clientY; if (touchY !== null && Number.isFinite(next)) { intent(next > touchY); touchY = next; } };
  const pointerdown = () => { userUntil = Date.now() + 600; userDirection = 0; };
  function scroll() {
    const top = container.scrollTop, user = Date.now() < userUntil;
    if (writing !== null && Math.abs(top - writing) < EPSILON) { writing = null; lastTop = top; return; }
    if (!user && Date.now() < smoothUntil) { lastTop = top; if (gap() <= EPSILON) { smoothUntil = 0; saved = capture(); } return; }
    if (user || !layoutPending && Math.abs(top - lastTop) >= EPSILON) {
      following = !(user && userDirection < 0) && gap() <= EPSILON; saved = capture(); writing = null;
    }
    lastTop = top;
  }
  function toBottom({ behavior = 'auto' } = {}) {
    following = true; userUntil = 0; smoothUntil = behavior === 'smooth' ? Date.now() + 1200 : 0;
    if (behavior === 'smooth') container.scrollTo({ top: container.scrollHeight, behavior });
    else write(container.scrollHeight);
    saved = capture();
  }
  container.addEventListener('scroll', scroll, { passive: true });
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
    destroyed = true; if (frame !== null) window.cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect();
    for (const [name, listener] of [['scroll', scroll], ['wheel', wheel], ['keydown', keydown], ['touchstart', touchstart], ['touchmove', touchmove], ['pointerdown', pointerdown]]) container.removeEventListener(name, listener);
    container.style.overflowAnchor = originalAnchor;
  } };
}
