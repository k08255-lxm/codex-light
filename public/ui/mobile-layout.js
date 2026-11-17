// Reuse the desktop controls and their state; moving them must not create another quota poller.
export function mountMobileLayout(document,window) {
  const narrow=window.matchMedia('(max-width:760px)'),foot=document.querySelector('.composer-foot');
  const bridge=window.CodexLightNative,canIntegrate=document.documentElement.dataset.mobileShell==='android'&&typeof bridge?.setToolbarIntegrated==='function';
  const controls=['permissions-info','context-meter','account-quota'].map(id=>{
    const node=document.getElementById(id),home=document.createComment(id+' desktop position');node.before(home);return {node,home};
  });
  const quotaSlot=document.getElementById('mobile-quota-slot');
  const update=document.getElementById('app-update-indicator');
  const updateHome=update?document.createComment('update indicator desktop position'):null;
  if(update)update.before(updateHome);
  function sync(){
    for(const {node,home}of controls){
      if(narrow.matches)(node.id==='account-quota'?quotaSlot:foot).append(node);
      else home.after(node);
    }
    if(update){if(narrow.matches)quotaSlot.before(update);else updateHome.after(update);}
    if(canIntegrate){document.documentElement.dataset.mobileToolbar=narrow.matches?'integrated':'';bridge.setToolbarIntegrated(narrow.matches);}
  }
  narrow.addEventListener('change',sync);sync();
  if(canIntegrate){
    document.getElementById('mobile-refresh').addEventListener('click',()=>window.location.reload());
    document.getElementById('mobile-connection').addEventListener('click',()=>bridge.openServerManager());
  }
}
