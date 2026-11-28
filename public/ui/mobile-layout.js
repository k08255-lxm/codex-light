// Reuse the desktop controls and their state; moving them must not create another quota poller.
export function mountMobileLayout(document,window) {
  const narrow=window.matchMedia('(max-width:760px)'),foot=document.querySelector('.composer-foot');
  const bridge=window.CodexLightNative,android=document.documentElement.dataset.mobileShell==='android';
  const controls=['permissions-info','context-meter','live-changes','account-quota'].map(id=>{
    const node=document.getElementById(id),home=document.createComment(id+' desktop position');node.before(home);return {node,home};
  });
  const quotaSlot=document.getElementById('mobile-quota-slot');
  const stats=foot.querySelector('.composer-stats');
  const update=document.getElementById('app-update-indicator');
  const updateHome=update?document.createComment('update indicator desktop position'):null;
  if(update)update.before(updateHome);
  function sync(){
    for(const {node,home}of controls){
      if(narrow.matches){
        if(node.id==='account-quota')quotaSlot.append(node);else foot.insertBefore(node,stats);
      }
      else home.after(node);
    }
    if(update){if(narrow.matches)quotaSlot.before(update);else updateHome.after(update);}
  }
  narrow.addEventListener('change',sync);sync();
  if(android&&typeof bridge?.setToolbarIntegrated==='function'&&typeof bridge.openServerManager==='function'){
    document.documentElement.dataset.mobileToolbar='integrated';
    bridge.setToolbarIntegrated(true);
    document.getElementById('mobile-refresh').addEventListener('click',()=>window.location.reload());
    document.getElementById('mobile-connection-settings').hidden=false;
    document.getElementById('mobile-connection').addEventListener('click',()=>bridge.openServerManager());
    if(typeof bridge.openApplicationSettings==='function'){
      document.getElementById('mobile-app-permissions-row').hidden=false;
      document.getElementById('mobile-app-permissions').addEventListener('click',()=>bridge.openApplicationSettings());
    }
    const compact=window.matchMedia('(max-width:760px) and (max-height:520px)');
    const settings=document.getElementById('rail-settings'),home=document.createComment('settings navigation position');
    settings.before(home);
    const caption=document.querySelector('.mobile-window-controls');
    function placeSettings(){
      const focused=document.activeElement===settings;
      if(compact.matches)caption.append(settings);else home.after(settings);
      if(focused)settings.focus({preventScroll:true});
    }
    compact.addEventListener('change',placeSettings);placeSettings();
  }
}
