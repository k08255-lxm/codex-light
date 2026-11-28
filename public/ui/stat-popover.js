// Shared by the reply and composer statistics. Only an open panel watches layout.
export function mountStatPopover(trigger,panel,{onOpen,onClose,focusOnOpen,boundary}={}) {
  const doc=panel.ownerDocument,win=doc.defaultView,native=typeof panel.showPopover==='function';
  let button=trigger;
  let open=false,observer=null;
  panel.setAttribute('popover',boundary?'manual':'auto');
  if(!native)panel.hidden=true;
  function position(){
    if(!open)return;
    const visual=win.visualViewport,x=visual?.offsetLeft||0,y=visual?.offsetTop||0;
    const w=visual?.width||doc.documentElement.clientWidth,h=visual?.height||doc.documentElement.clientHeight;
    const anchor=button.getBoundingClientRect();
    if(boundary){
      const bounds=boundary.getBoundingClientRect();
      const left=Math.max(x+16,bounds.left),right=Math.min(x+w-16,bounds.right);
      if(anchor.right<=left||anchor.left>=right||anchor.bottom<=y||anchor.top>=y+h){close();return;}
      panel.style.maxWidth=Math.max(0,right-left)+'px';
      const above=anchor.top-y-24,below=y+h-anchor.bottom-24;
      const side=below>=panel.scrollHeight+2||below>=above?'bottom':'top';
      panel.style.setProperty('--available-height',Math.max(0,side==='bottom'?below:above)+'px');
      // Transforms animate the painted box. Layout dimensions keep its anchor still.
      const width=panel.offsetWidth,height=panel.offsetHeight;
      const start=Math.max(left,Math.min(anchor.left,right-width));
      panel.style.left=start+'px';
      panel.style.top=(side==='bottom'?anchor.bottom+8:anchor.top-8-height)+'px';
      panel.style.setProperty('--anchor-x',Math.min(width,Math.max(0,anchor.left+anchor.width/2-start))+'px');
      panel.dataset.side=side;
      return;
    }
    const box=panel.getBoundingClientRect();
    panel.style.left=Math.max(x+8,Math.min(anchor.left,x+w-box.width-8))+'px';
    const above=anchor.top-box.height-8;
    panel.style.top=Math.max(y+8,Math.min(above>=y+8?above:anchor.bottom+8,y+h-box.height-8))+'px';
  }
  function outside(e){if(!panel.contains(e.target)&&!button.contains(e.target))close();}
  function key(e){if(e.key==='Escape'){e.preventDefault();e.stopPropagation?.();close(true);}}
  function stop(){
    if(!open)return;
    open=false;button.setAttribute('aria-expanded','false');delete panel.dataset.open;
    doc.removeEventListener('scroll',position,true);win.removeEventListener('resize',position);
    win.visualViewport?.removeEventListener('resize',position);win.visualViewport?.removeEventListener('scroll',position);
    doc.removeEventListener('keydown',key,true);doc.removeEventListener('pointerdown',outside,true);
    observer?.disconnect();observer=null;onClose?.();
  }
  function close(focus=false){
    if(!open)return;
    if(native)panel.hidePopover();else panel.hidden=true;
    stop();if(focus&&button.getClientRects?.().length)button.focus({preventScroll:true});
  }
  panel.addEventListener('toggle',event=>{if(event.newState==='closed'&&!panel.matches(':popover-open'))stop();});
  function show(anchor=trigger){
    if(open){
      observer?.unobserve(button);button.setAttribute('aria-expanded','false');
      button=anchor;button.setAttribute('aria-expanded','true');observer?.observe(button);position();return;
    }
    button=anchor;
    if(native)panel.showPopover();else panel.hidden=false;
    open=true;button.setAttribute('aria-expanded','true');panel.dataset.open='true';
    onOpen?.();position();if(!open)return;focusOnOpen?.focus({preventScroll:true});
    doc.addEventListener('scroll',position,true);win.addEventListener('resize',position);
    win.visualViewport?.addEventListener('resize',position);win.visualViewport?.addEventListener('scroll',position);
    doc.addEventListener('keydown',key,true);if(!native||boundary)doc.addEventListener('pointerdown',outside,true);
    if(win.ResizeObserver){observer=new win.ResizeObserver(position);observer.observe(panel);observer.observe(button);if(boundary)observer.observe(boundary);}
  }
  trigger?.addEventListener('click',()=>open?close():show());
  return {show,close,position,get open(){return open;},get anchor(){return open?button:null;}};
}
