// Width preferences contain geometry only; overlay panels retain their existing focus behavior.
export function mountPanelResize({document, window, app = document.getElementById('app')}) {
  const root = document.documentElement;
  const storageKey = 'codex-light-panel-widths-v1';
  let preferred = {sidebar:272, details:340};
  try { const saved=JSON.parse(window.localStorage.getItem(storageKey)); for(const key of Object.keys(preferred))if(Number.isFinite(saved?.[key]))preferred[key]=Math.max(200,Math.min(640,saved[key])); } catch { /* Geometry preferences are optional. */ }
  const controls=[];
  function visible(node) { return node && window.getComputedStyle(node).display!=='none' && window.getComputedStyle(node).visibility!=='hidden'; }
  function limits(key) {
    const width=app.clientWidth;
    const other=key==='sidebar'?document.getElementById('details'):document.getElementById('sidebar');
    const panel=document.getElementById(key),overlay=panel&&['absolute','fixed'].includes(window.getComputedStyle(panel).position);
    const otherWidth=!overlay&&visible(other)&&!['absolute','fixed'].includes(window.getComputedStyle(other).position)?other.getBoundingClientRect().width:0;
    const min=key==='sidebar'?200:260;
    return {min,max:Math.max(min,Math.min(key==='sidebar'?480:640,width-52-otherWidth-360))};
  }
  function apply() {
    for(const control of controls){
      const {key,panel,handle}=control; const enabled=window.innerWidth>760&&visible(panel);
      handle.hidden=!enabled;handle.tabIndex=enabled?0:-1;
      const {min,max}=limits(key); const value=Math.max(min,Math.min(max,preferred[key]));
      root.style.setProperty(key==='sidebar'?'--sidebar-width':'--details-width',`${value}px`);
      handle.setAttribute('aria-valuemin',String(min));handle.setAttribute('aria-valuemax',String(max));handle.setAttribute('aria-valuenow',String(Math.round(value)));
      handle.setAttribute('aria-valuetext',`${Math.round(value)} 像素`);
    }
  }
  function save(){try{window.localStorage.setItem(storageKey,JSON.stringify(preferred));}catch{/* Keep the current width when storage is unavailable. */}}
  for(const key of ['sidebar','details']){
    const panel=document.getElementById(key); if(!panel)continue;
    const handle=document.createElement('div');handle.className=`panel-resize-handle panel-resize-${key}`;handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label',key==='sidebar'?'调整项目与设置侧栏宽度':'调整活动侧栏宽度');handle.setAttribute('aria-controls',key);handle.title='拖动调整宽度；方向键微调；双击复位';panel.append(handle);
    const control={key,panel,handle};controls.push(control);
    let drag=null;
    handle.addEventListener('pointerdown',event=>{if(event.button!==0||handle.hidden)return;event.preventDefault();handle.focus();drag={id:event.pointerId,x:event.clientX,width:panel.getBoundingClientRect().width};handle.setPointerCapture(event.pointerId);root.classList.add('panel-resizing');});
    handle.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;const {min,max}=limits(key);preferred[key]=Math.max(min,Math.min(max,drag.width+(event.clientX-drag.x)*(key==='sidebar'?1:-1)));apply();});
    function finish(){if(!drag)return;drag=null;root.classList.remove('panel-resizing');save();}
    handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('lostpointercapture',finish);
    handle.addEventListener('dblclick',()=>{preferred[key]=key==='sidebar'?272:340;apply();save();});
    handle.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const {min,max}=limits(key);const current=panel.getBoundingClientRect().width;preferred[key]=event.key==='Home'?min:event.key==='End'?max:Math.max(min,Math.min(max,current+(event.key==='ArrowRight'?1:-1)*(key==='sidebar'?1:-1)*(event.shiftKey?32:8)));apply();save();});
  }
  const observer=new window.MutationObserver(apply);observer.observe(app,{attributes:true,attributeFilter:['class','data-view']});for(const {panel}of controls)observer.observe(panel,{attributes:true,attributeFilter:['class']});
  window.addEventListener('resize',apply);apply();
  return {refresh:apply,destroy(){observer.disconnect();window.removeEventListener('resize',apply);for(const {handle}of controls)handle.remove();}};
}
