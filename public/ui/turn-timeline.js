// Adapted from DeepSeek Harness TurnNavigator and turn-navigation (MIT).
export function compactTimelineMedia(doc) {
  const query = doc.documentElement.dataset.mobileShell === 'android'
    ? 'all' : '(max-width:760px), (pointer:coarse) and (max-height:600px)';
  return doc.defaultView.matchMedia?.(query);
}

function excerpt(parts,limit){
  let text='',clipped=false;
  for(const part of parts){
    if(typeof part!=='string'||!part)continue;
    const room=limit*2-text.length;
    if(room<=0){clipped=true;break;}
    text+=(text?' ':'')+part.slice(0,room);
    if(part.length>room){clipped=true;break;}
  }
  const clean=text.replace(/\s+/g,' ').trim();
  if(clean.length>=limit)return clean.slice(0,limit-1).replace(/[\uD800-\uDBFF]$/,'').trimEnd()+'…';
  return clipped&&clean?clean+'…':clean;
}
function responsePreview(turn){
  const items=turn.items??turn.segments.flatMap(segment=>[...segment.process,...segment.answers]);
  for(let i=items.length-1;i>=0;i--){
    const item=items[i];
    if(item.type!=='agentMessage')continue;
    const parts=typeof item.text==='string'?[item.text]:Array.isArray(item.content)
      ?item.content.filter(block=>block?.type==='text').map(block=>block.text):[item.content];
    const text=excerpt(parts,120);
    if(text)return text;
  }
  return '';
}

// Render marks for all loaded turns, including those currently represented by spacers.
export function mountTurnTimeline(rail, scroller, host, {jumpTo}) {
  const doc = rail.ownerDocument, narrow = compactTimelineMedia(doc);
  const marks = rail.querySelector('.turn-marks'), preview = rail.querySelector('.turn-preview');
  const buttons = new Map();
  const prompt=preview.querySelector('.turn-preview-prompt'),reply=preview.querySelector('.turn-preview-response');
  let items = [], active = null, selected = null;
  function hidePreview() {
    selected?.removeAttribute('aria-describedby');selected=null;preview.hidden=true;
  }
  function positionPreview(){
    if(!selected)return;
    const center=selected.offsetTop+selected.offsetHeight/2-marks.scrollTop;
    preview.hidden=center<0||center>marks.clientHeight;
    preview.style.setProperty('--turn-preview-center',center+'px');
    if(preview.hidden)selected.removeAttribute('aria-describedby');else selected.setAttribute('aria-describedby',preview.id);
  }
  function refreshPreview(turnId){
    if(!selected || (turnId!==undefined&&selected.dataset.turn!==turnId))return;
    const turn=items[Number(selected.dataset.index)];
    if(!turn || selected.dataset.turn!==turn.id){hidePreview();return;}
    const question=selected.dataset.prompt||'第 '+(Number(selected.dataset.index)+1)+' 轮';
    const answer=responsePreview(turn);
    if(prompt.textContent!==question)prompt.textContent=question;
    if(reply.textContent!==answer)reply.textContent=answer;
    reply.hidden=!answer;
  }
  function showPreview(button) {
    if(selected===button)return;
    selected?.removeAttribute('aria-describedby');selected=button;
    refreshPreview();positionPreview();
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
    hidePreview();
    const index = Number(button.dataset.index);
    if (items[index]?.id === button.dataset.turn) jumpTo(items[index].id, index);
  }
  marks.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button) jump(button);
  });
  for (const type of ['pointermove','focusin']) marks.addEventListener(type, event => {
    const button = event.target.closest('button');
    if (button && event.pointerType !== 'touch') showPreview(button);
  });
  marks.addEventListener('pointerleave', hidePreview);
  marks.addEventListener('focusout', event=>{if(!marks.contains(event.relatedTarget))hidePreview();});
  marks.addEventListener('scroll', positionPreview, {passive:true});
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
  function clear() {
    hidePreview(); buttons.clear(); items=[]; active=null;
    marks.replaceChildren(); marks.scrollTop=0; rail.hidden=true;
  }
  function update(list) {
    if(narrow?.matches){
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
        entry.dataset.prompt=excerpt((prompt?.content||[]).filter(part=>part?.type==='text').map(part=>part.text),50);
        entry.setAttribute('aria-label','跳转到第 '+(index+1)+' 轮');
      }
      if (marks.children[index] !== entry) marks.insertBefore(entry, marks.children[index] || null);
    }
    for (const [id,button] of buttons) if (!keep.has(id)) {
      if(selected===button)hidePreview();
      button.remove(); buttons.delete(id);
    }
    updateActive();refreshPreview();positionPreview();
  }
  narrow?.addEventListener('change',()=>{const list=items;clear();update(list);});
  return {update,clear,refreshPreview};
}
