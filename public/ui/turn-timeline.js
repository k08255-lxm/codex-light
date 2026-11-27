import {itemText} from '../store.js';

// Render marks for all loaded turns, including those currently represented by spacers.
export function mountTurnTimeline(rail, scroller, host, {pause, reveal}) {
  const doc = rail.ownerDocument, win = doc.defaultView;
  const narrow=win.matchMedia?.('(max-width:760px), (pointer:coarse) and (max-height:600px)');
  const marks = rail.querySelector('.turn-marks'), preview = rail.querySelector('.turn-preview');
  const buttons = new Map();
  let items = [], active = null, jumpFrame = null;
  function cancelJump() {
    if (jumpFrame !== null) win.cancelAnimationFrame(jumpFrame);
    jumpFrame = null;
  }
  function hidePreview() { preview.hidden = true; }
  function showPreview(button) {
    preview.textContent = button.getAttribute('aria-label');
    preview.hidden = false;
    const top = button.getBoundingClientRect().top - rail.getBoundingClientRect().top;
    preview.style.top = Math.max(0, Math.min(rail.clientHeight - preview.offsetHeight, top)) + 'px';
  }
  function updateActive() {
    if (rail.hidden || !host.children.length || !scroller.clientHeight) return;
    const anchor = scroller.getBoundingClientRect().top + Math.min(80, scroller.clientHeight / 4);
    let lo = 0, hi = host.children.length - 1;
    if (scroller.scrollTop > 0 && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 2) lo = hi;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (host.children[mid].getBoundingClientRect().top <= anchor) lo = mid;
      else hi = mid - 1;
    }
    const node = host.children[lo], key = node.dataset.turnId || node.dataset.virtualTurnId;
    const next = buttons.get(key);
    if (!next || active === next) return;
    if (active) { active.removeAttribute('aria-current'); active.tabIndex = -1; }
    active = next;
    next.setAttribute('aria-current', 'location');
    next.tabIndex = 0;
    if (!marks.contains(doc.activeElement) && !marks.matches(':hover')) {
      const top = next.offsetTop;
      if (top < marks.scrollTop || top + next.offsetHeight > marks.scrollTop + marks.clientHeight)
        marks.scrollTop = top - marks.clientHeight / 2;
    }
  }
  function jump(button) {
    cancelJump(); hidePreview(); pause();
    const index = Number(button.dataset.index), id = button.dataset.turn;
    const motion = doc.documentElement.dataset.reducedMotion !== 'true';
    const start = scroller.scrollTop, time = win.performance.now();
    // Measured heights may change as spacers become real turns during the jump.
    function step(now) {
      if (items[index]?.id !== id || !host.children[index]) { cancelJump(); return; }
      const t = motion ? Math.min(1, (now - time) / 210) : 1;
      if (t === 1) reveal(id);
      const target = scroller.scrollTop + host.children[index].getBoundingClientRect().top -
        scroller.getBoundingClientRect().top - 8;
      scroller.scrollTop = start + (target - start) * (1 - (1 - t) ** 3);
      jumpFrame = t < 1 ? win.requestAnimationFrame(step) : null;
      if (t === 1) { pause(); updateActive(); }
    }
    step(time);
  }
  marks.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button) jump(button);
  });
  for (const type of ['pointerover','focusin']) marks.addEventListener(type, event => {
    const button = event.target.closest('button');
    if (button && event.pointerType !== 'touch') showPreview(button);
  });
  marks.addEventListener('pointerleave', hidePreview);
  marks.addEventListener('focusout', hidePreview);
  marks.addEventListener('scroll', hidePreview, {passive:true});
  marks.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('button')) {
      event.preventDefault(); if (!event.repeat) jump(event.target); return;
    }
    const index = Number(event.target.dataset.index);
    const next = {ArrowDown:index+1, ArrowUp:index-1, Home:0, End:items.length-1}[event.key];
    if (next === undefined || !Number.isInteger(index)) return;
    event.preventDefault();
    marks.children[Math.max(0, Math.min(items.length-1,next))]?.focus();
  });
  for (const type of ['wheel','touchstart','pointerdown','keydown']) scroller.addEventListener(type, cancelJump, {passive:true});
  function clear() {
    cancelJump(); hidePreview(); buttons.clear(); items=[]; active=null;
    marks.replaceChildren(); marks.scrollTop=0; rail.hidden=true;
  }
  function update(list) {
    if(narrow?.matches||doc.documentElement.dataset.mobileShell==='android'){
      if(!rail.hidden||buttons.size)clear();
      items=list;
      return;
    }
    if (items === list) { updateActive(); return; }
    items = list;
    rail.hidden = list.length < 2;
    if (rail.hidden) { if (buttons.size) clear(); return; }
    const keep = new Set();
    for (const [index,turn] of list.entries()) {
      let entry = buttons.get(turn.id);
      if (!entry) {
        entry = doc.createElement('button'); entry.type = 'button'; entry.tabIndex = -1;
        entry.dataset.turn = turn.id;
        buttons.set(turn.id,entry);
      }
      keep.add(turn.id);
      const prompt = turn.segments[0]?.user;
      if (entry._prompt !== prompt || entry.dataset.index !== String(index)) {
        entry._prompt = prompt; entry.dataset.index = String(index);
        const summary = prompt ? itemText(prompt).slice(0,100).replace(/\s+/g,' ').trim() : '';
        entry.setAttribute('aria-label', '第 '+(index+1)+' 轮'+(summary?' · '+summary:''));
      }
      if (marks.children[index] !== entry) marks.insertBefore(entry, marks.children[index] || null);
    }
    for (const [id,button] of buttons) if (!keep.has(id)) {
      hidePreview(); button.remove(); buttons.delete(id);
    }
    updateActive();
  }
  narrow?.addEventListener('change',()=>{const list=items;clear();update(list);});
  return {update,clear};
}
