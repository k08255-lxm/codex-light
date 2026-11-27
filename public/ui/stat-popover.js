// Shared by the reply and composer statistics. Only an open panel watches layout.
export function mountStatPopover(button,panel,{onOpen,onClose,focusOnOpen}={}) {
  const doc=button.ownerDocument,win=doc.defaultView,native=typeof panel.showPopover==='function';
  let open=false,observer=null;
  panel.setAttribute('popover','auto');
  if(!native)panel.hidden=true;
  function position(){
    if(!open)return;
    const visual=win.visualViewport,x=visual?.offsetLeft||0,y=visual?.offsetTop||0;
    const w=visual?.width||win.innerWidth,h=visual?.height||win.innerHeight;
    const anchor=button.getBoundingClientRect(),box=panel.getBoundingClientRect();
    panel.style.left=Math.max(x+8,Math.min(anchor.left,x+w-box.width-8))+'px';
    const above=anchor.top-box.height-8;
    panel.style.top=Math.max(y+8,Math.min(above>=y+8?above:anchor.bottom+8,y+h-box.height-8))+'px';
  }
  function outside(e){if(!panel.contains(e.target)&&!button.contains(e.target))close();}
  function key(e){if(e.key==='Escape'){e.preventDefault();e.stopPropagation?.();close(true);}}
  function stop(){
    if(!open)return;
    open=false;button.setAttribute('aria-expanded','false');
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
  button.addEventListener('click',()=>{
    if(open){close();return;}
    if(native)panel.showPopover();else panel.hidden=false;
    open=true;button.setAttribute('aria-expanded','true');
    onOpen?.();position();focusOnOpen?.focus({preventScroll:true});
    doc.addEventListener('scroll',position,true);win.addEventListener('resize',position);
    win.visualViewport?.addEventListener('resize',position);win.visualViewport?.addEventListener('scroll',position);
    doc.addEventListener('keydown',key,true);if(!native)doc.addEventListener('pointerdown',outside,true);
    if(win.ResizeObserver){observer=new win.ResizeObserver(position);observer.observe(panel);observer.observe(button);}
  });
  return {close,position,get open(){return open;}};
}
