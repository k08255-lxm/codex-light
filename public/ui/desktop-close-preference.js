// Only the native WebView injects this API. No HTTP route or host preference in LAN/browser mode.
export function mountDesktopClosePreference({root=document,host=window}={}){
 const api=host.codexLightCloseBehavior,panel=root.getElementById('desktop-close-preference'),select=root.getElementById('desktop-close-behavior'),status=root.getElementById('desktop-close-status');
 if(!api||!panel||!select||!status)return null;
 panel.classList.remove('hidden');let value='ask',generation=0,busy=false;
 const valid=v=>['ask','tray','exit'].includes(v);
 const display=result=>{if(!valid(result?.behavior))throw new Error('关闭偏好返回无效');value=result.behavior;select.value=value;status.textContent=result.warning||'';};
 async function refresh(){if(busy)return;const current=++generation;select.disabled=true;try{const result=await api.get();if(current===generation)display(result);}catch{if(current===generation)status.textContent='无法读取关闭偏好，请重新打开设置或聚焦窗口重试。';}finally{if(current===generation)select.disabled=false;}}
 async function change(){if(busy)return;busy=true;const current=++generation,chosen=select.value;select.disabled=true;status.textContent='保存中…';try{const result=await api.set(chosen);if(current===generation){display(result);status.textContent='已保存';}}catch{if(current===generation){select.value=value;status.textContent='未能保存，仍使用原来的关闭方式。';}}finally{if(current===generation){busy=false;select.disabled=false;}}}
 function changed(event){if(valid(event.detail)){++generation;busy=false;select.disabled=false;display({behavior:event.detail});}}
 select.addEventListener('change',change);host.addEventListener('focus',refresh);host.addEventListener('desktop-close-behavior-changed',changed);void refresh();
 return{refresh,destroy(){++generation;select.removeEventListener('change',change);host.removeEventListener('focus',refresh);host.removeEventListener('desktop-close-behavior-changed',changed);}};
}
