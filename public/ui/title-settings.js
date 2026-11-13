import {el} from './format.js';

export function mountTitleSettings(host,{api}){
 const document=host.ownerDocument;let busy=false;
 const panel=el(document,'div','panel');
 const enabled=el(document,'input');enabled.type='checkbox';enabled.setAttribute('aria-label','自动总结对话标题');
 const toggle=el(document,'label','pref-row');const copy=el(document,'div');copy.append(el(document,'strong','','自动总结对话标题'),el(document,'small','fine','默认关闭；开启后，新对话首轮结束时额外调用所选模型一次。'));toggle.append(copy,enabled);
 const model=el(document,'select');model.setAttribute('aria-label','标题总结模型');
 const modelRow=el(document,'label','pref-row');modelRow.append(el(document,'strong','','总结模型'),model);
 const refresh=el(document,'button','btn','刷新模型');refresh.type='button';const save=el(document,'button','btn primary','保存标题设置');save.type='button';
 const actions=el(document,'div','work-row end');actions.append(refresh,save);
 const status=el(document,'p','fine');status.setAttribute('role','status');
 panel.append(toggle,modelRow,actions,status);host.replaceChildren(el(document,'h2','section-title','对话标题'),panel);
 function option(label,value){const node=el(document,'option','',label);node.value=value;return node;}
 function setBusy(value){busy=value;for(const node of [enabled,model,refresh,save])node.disabled=value;}
 async function models(selected=model.value){const result=await api('/api/title-summary/models',{});model.replaceChildren(option('请选择模型',''),...(result.data||[]).map(row=>option(row.displayName===row.model?row.model:`${row.displayName} · ${row.model}`,row.model)));if(selected&&!(result.data||[]).some(row=>row.model===selected))model.append(option(selected+'（当前不可用）',selected));model.value=selected||'';}
 async function load(){if(busy)return;setBusy(true);try{const state=await api('/api/title-summary/status',{});enabled.checked=state.enabled===true;await models(state.model);status.textContent=state.lastError||'';}catch(error){status.textContent=error.message;}finally{setBusy(false);}}
 refresh.addEventListener('click',async()=>{if(busy)return;setBusy(true);try{await models();status.textContent='模型列表已更新。';}catch(error){status.textContent=error.message;}finally{setBusy(false);}});
 save.addEventListener('click',async()=>{if(busy)return;if(enabled.checked&&!model.value){status.textContent='请先选择总结模型。';model.focus();return;}setBusy(true);try{await api('/api/title-summary/configure',{enabled:enabled.checked===true,model:model.value||null});status.textContent='已保存';}catch(error){status.textContent=error.message;}finally{setBusy(false);}});
 return {load,activate(){void load();},reset(){status.textContent='';}};
}
