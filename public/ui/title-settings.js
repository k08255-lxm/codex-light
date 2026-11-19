import {el} from './format.js';

export function mountTitleSettings(host,{api}){
 const document=host.ownerDocument;let busy=false;
 const panel=el(document,'div','panel');
 const enabled=el(document,'input','switch');enabled.type='checkbox';enabled.setAttribute('aria-label','自动总结对话标题');
 const toggle=el(document,'label','pref-row');const copy=el(document,'div');copy.append(el(document,'strong','','自动总结对话标题'),el(document,'small','fine','默认从首条消息提炼本地标题。开启后，首轮结束和手动选择“摘要标题”时使用所选模型，失败或超时会保留本地标题。'));toggle.append(copy,enabled);
 const model=el(document,'select');model.id='title-summary-model';model.setAttribute('aria-label','标题总结模型');
 const modelLabel=el(document,'label');modelLabel.htmlFor=model.id;modelLabel.append(el(document,'strong','','总结模型'));
 const modelRow=el(document,'div','pref-row title-settings-model');
 const refresh=el(document,'button','btn','刷新模型');refresh.type='button';const save=el(document,'button','btn primary','保存标题设置');save.type='button';
 function feedback(){const node=el(document,'p','fine settings-feedback');node.setAttribute('role','status');return node;}
 const modelStatus=feedback(),testStatus=feedback(),saveStatus=feedback();
 function announce(target,message){for(const status of [modelStatus,testStatus,saveStatus])status.textContent=status===target?message:'';}
 const modelControls=el(document,'div','title-model-controls');modelControls.append(model,refresh);
 const modelField=el(document,'div','title-model-field');modelField.append(modelControls,modelStatus);modelRow.append(modelLabel,modelField);
 const test=el(document,'button','btn','立即测试');test.type='button';
 const hint=el(document,'p','fine','使用所选模型总结一段固定示例，产生一次模型请求。');hint.id='title-summary-test-hint';test.setAttribute('aria-describedby',hint.id);
 const testCopy=el(document,'div','title-test-copy');testCopy.append(hint,testStatus);
 const testRow=el(document,'div','settings-action-row');testRow.append(testCopy,test);
 const saveRow=el(document,'div','settings-action-row');saveRow.append(saveStatus,save);
 panel.append(toggle,modelRow,testRow,saveRow);host.replaceChildren(el(document,'h2','section-title','对话标题'),panel);
 function option(label,value){const node=el(document,'option','',label);node.value=value;return node;}
 function setBusy(value){busy=value;for(const node of [enabled,model,refresh,test,save])node.disabled=value;panel.setAttribute('aria-busy',String(value));}
 async function models(selected=model.value){const result=await api('/api/title-summary/models',{});model.replaceChildren(option('请选择模型',''),...(result.data||[]).map(row=>option(row.displayName===row.model?row.model:`${row.displayName} · ${row.model}`,row.model)));if(selected&&!(result.data||[]).some(row=>row.model===selected))model.append(option(selected+'（当前不可用）',selected));model.value=selected||'';}
 async function load(){if(busy)return;setBusy(true);try{const state=await api('/api/title-summary/status',{});enabled.checked=state.enabled===true;await models(state.model);announce(saveStatus,state.lastError||'');}catch(error){announce(saveStatus,error.message);}finally{setBusy(false);}}
 refresh.addEventListener('click',async()=>{if(busy)return;setBusy(true);try{await models();announce(modelStatus,'模型列表已更新。');}catch(error){announce(modelStatus,error.message);}finally{setBusy(false);}});
 save.addEventListener('click',async()=>{if(busy)return;if(enabled.checked&&!model.value){announce(saveStatus,'请先选择总结模型。');model.focus();return;}setBusy(true);try{await api('/api/title-summary/configure',{enabled:enabled.checked===true,model:model.value||null});announce(saveStatus,'已保存');}catch(error){announce(saveStatus,error.message);}finally{setBusy(false);}});
 test.addEventListener('click',async()=>{
  if(busy)return;
  if(!model.value){announce(testStatus,'请先选择要测试的模型。');model.focus();return;}
  setBusy(true);test.textContent='测试中…';announce(testStatus,'正在等待示例标题…');
  try{const result=await api('/api/title-summary/test',{model:model.value});announce(testStatus,'测试成功 · '+result.title);}
  catch(error){announce(testStatus,'测试失败 · '+error.message);}
  finally{test.textContent='立即测试';setBusy(false);}
 });
 return {load,activate(){void load();},reset(){announce(saveStatus,'');}};
}
