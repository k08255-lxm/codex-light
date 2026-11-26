const THREAD_LIMIT='agents.max_concurrent_threads_per_session';
const labels={model:'默认模型',model_reasoning_effort:'思考强度',web_search:'网页搜索',approval_policy:'批准策略',sandbox_mode:'沙盒模式',[THREAD_LIMIT]:'并发线程上限'};
const text=value=>value==null?'引擎默认':String(value).slice(0,2000);

export function mountConfigSettingsPanel(container,{read,plan,apply,setContextWindow,readWindowCatalog,clock=()=>Date.now()}={}){
 if([read,plan,apply].some(fn=>typeof fn!=='function'))throw new TypeError('read/plan/apply callbacks required');
 const doc=container.ownerDocument,inputs=new Map();
 const node=(tag,label,cls)=>{const n=doc.createElement(tag);if(label!==undefined)n.textContent=label;if(cls)n.className=cls;return n;};
 const button=(label,cls='btn')=>{const b=node('button',label,cls);b.type='button';return b;};
 const heading=node('h2','Codex 用户默认配置','section-title');
 const note=node('p','保存后用于新会话。','fine');
 const status=node('p','','fine config-settings-status');status.setAttribute('role','status');
 const fields=node('div',undefined,'config-settings-fields'),diff=node('div',undefined,'config-settings-diff');
 const refresh=button('重新读取'),save=button('保存更改','btn primary'),confirm=button('确认更改','btn primary'),cancel=button('取消修改');
 const controls=node('div',undefined,'config-settings-controls');controls.append(refresh,cancel,save,confirm);
 container.replaceChildren(heading,note,fields,diff,status,controls);container.classList.add('config-settings-panel');
 let snapshot=null,prepared=null,busy=false,unknown=false,generation=0,disposed=false;
 const windowPanel=node('section'),windowModel=node('select'),windowSize=node('input'),windowStatus=node('p','','fine');
 const windowSave=button('保存窗口大小','btn primary'),windowClear=button('恢复引擎默认'),catalogRefresh=button('重新读取模型目录');
 const windowMode=node('strong'),catalogInfo=node('p','','fine');
 if(setContextWindow){
  const modelLabel=node('label','模型'),sizeLabel=node('label','上下文大小（tokens）');
  modelLabel.append(windowModel);sizeLabel.append(windowSize);
  windowSize.type='number';windowSize.min='1';windowSize.step='1';windowSize.inputMode='numeric';windowSize.placeholder='引擎默认';
  windowStatus.setAttribute('role','status');
  const controls=node('div',undefined,'config-settings-controls');controls.append(windowSave,windowClear);if(readWindowCatalog)controls.append(catalogRefresh);
  const fields=node('div',undefined,'config-settings-fields');
  for(const label of [modelLabel,sizeLabel]){const row=node('div',undefined,'config-settings-field');row.append(label);fields.append(row);}
  windowPanel.append(node('h2','模型上下文窗口','section-title'),node('p','按模型设置，下次开始一轮时生效。','fine'),fields,windowMode,catalogInfo,controls,windowStatus);
  container.append(windowPanel);
 }
 function showWindowInfo(){
  const model=windowModel.value,catalog=snapshot?.windowCatalog;
  const custom=Object.hasOwn(snapshot?.contextWindows||{},model);
  windowMode.textContent=custom?'当前使用自定义窗口':'当前跟随引擎默认';
  const entry=Object.hasOwn(catalog?.models||{},model)?catalog.models[model]:null;
  const format=value=>value.toLocaleString('zh-CN');
  const lines=[];
  if(entry){
   const range=entry.max&&entry.max!==entry.size?'，目录上限 '+format(entry.max):'';
   lines.push('Codex 本机模型目录：标称窗口 '+format(entry.size)+range+' tokens。');
   if(catalog.fetchedAt)lines.push('目录更新时间 '+new Date(catalog.fetchedAt).toLocaleString('zh-CN')+'。');
  }else if(catalog?.status==='invalid'||catalog?.status==='unreadable'){
   lines.push('暂时无法读取本机模型目录。');
  }else lines.push('本机模型目录未提供此模型的窗口大小。');
  if(snapshot?.engineContextWindow)lines.push('当前项目的 Codex 配置指定了 '+format(snapshot.engineContextWindow)+' tokens。');
  lines.push('本轮实际可用窗口可在对话的「上下文详情」查看。');
  catalogInfo.textContent=lines.join(' ');
 }
 function showWindowSize(){
  const size=Object.hasOwn(snapshot?.contextWindows||{},windowModel.value)?snapshot.contextWindows[windowModel.value]:null;
  windowSize.value=size==null?'':String(size);windowClear.disabled=size==null||busy;
  showWindowInfo();
 }
 function showModels(){
  const previous=windowModel.value;
  const models=new Set([...(snapshot.models||[]).map(m=>m.model),...Object.keys(snapshot.contextWindows||{})]);
  if(snapshot.fields.model?.value)models.add(snapshot.fields.model.value);
  windowModel.replaceChildren();
  for(const model of models){const option=node('option',model);option.value=model;windowModel.append(option);}
  if(models.has(previous))windowModel.value=previous;
  else if(snapshot.fields.model?.value)windowModel.value=snapshot.fields.model.value;
  showWindowSize();
 }
 async function saveWindow(clear){
  if(!snapshot||busy||!windowModel.value)return;
  const model=windowModel.value,size=clear?null:Number(windowSize.value);
  if(!clear&&(!Number.isSafeInteger(size)||size<=0)){windowStatus.textContent='请输入大于零的整数。';windowSize.focus();return;}
  const version=generation;busy=true;sync();windowStatus.textContent='正在保存…';
  try{
   const result=await setContextWindow(model,size);if(!current(version))return;
   snapshot.contextWindows=result.contextWindows;showModels();windowStatus.textContent=clear?'已恢复引擎默认值。':'已保存 '+model+' 的上下文大小。';
  }catch(error){if(current(version))windowStatus.textContent=error.message||'保存失败，请重试。';}
  finally{if(current(version)){busy=false;sync();}}
 }
 windowModel.addEventListener('change',()=>{showWindowSize();windowStatus.textContent='';});
 windowSave.addEventListener('click',()=>saveWindow(false));windowClear.addEventListener('click',()=>saveWindow(true));
 catalogRefresh.addEventListener('click',async()=>{
  if(!readWindowCatalog||!snapshot||busy)return;
  const version=generation;busy=true;sync();windowStatus.textContent='正在读取本机模型目录…';
  try{
   const result=await readWindowCatalog();if(!current(version))return;
   snapshot.windowCatalog=result;showWindowInfo();windowStatus.textContent=result.status==='ready'?'已重新读取本机目录。':'';
  }catch(error){if(current(version))windowStatus.textContent=error.message||'读取失败，请重试。';}
  finally{if(current(version)){busy=false;sync();}}
 });
 const current=v=>!disposed&&generation===v;
 function changes(){
  if(!snapshot)return [];
  const updates=[];
  for(const [key,control] of inputs){
   const value=control.value;
   if(String(value)!==String(snapshot.fields[key].value??''))updates.push({key,value:key===THREAD_LIMIT?Number(value):value});
  }
  return updates;
 }
 function sync(){
  const dirty=changes().length>0;
  fields.hidden=!snapshot;diff.hidden=!prepared;save.hidden=!dirty||!!prepared;confirm.hidden=!prepared;cancel.hidden=!dirty&&!prepared;
  refresh.disabled=busy;save.disabled=busy||unknown;confirm.disabled=busy||unknown;cancel.disabled=busy;
  for(const control of inputs.values())control.disabled=busy||unknown;
  container.setAttribute('aria-busy',String(busy));
  windowPanel.hidden=!snapshot||!setContextWindow;
  windowModel.disabled=busy;windowSize.disabled=windowSave.disabled=busy||!windowModel.value;
  catalogRefresh.disabled=busy;
  windowClear.disabled=busy||!Object.hasOwn(snapshot?.contextWindows||{},windowModel.value);
 }
 function clearPlan(){prepared=null;diff.replaceChildren();}
 function options(control,values,selected,label){
  control.replaceChildren();
  for(const value of new Set([selected,...values])){
   const opt=node('option',value===selected?label:text(value));opt.value=String(value??'');control.append(opt);
  }
  control.value=String(selected??'');
 }
 function renderFields(){
  fields.replaceChildren();inputs.clear();
  for(const [key,label] of Object.entries(labels)){
   const f=snapshot.fields[key];if(!f||f.readonly!==false)continue;
   if(key!==THREAD_LIMIT&&!(f.options||[]).some(value=>value!==f.value))continue;
   const wrapper=node('div',undefined,'config-settings-field'),row=node('label');
   const copy=node('span',undefined,'setting-copy');copy.append(node('strong',label));
   let control;
   if(key===THREAD_LIMIT){
    control=node('input');control.type='number';control.min='1';control.step='1';control.inputMode='numeric';control.placeholder='引擎默认';control.value=String(f.value??'');
    copy.append(node('small','包含主线程，调整后在新会话生效。','fine'));
   }else{
    control=node('select');options(control,f.options,f.value,f.label);
   }
   control.setAttribute('aria-label',label);row.append(copy,control);wrapper.append(row);fields.append(wrapper);inputs.set(key,control);
   const change=()=>{
    clearPlan();
    if(key==='model'){
     const effort=inputs.get('model_reasoning_effort');
     if(effort){const value=effort.value;options(effort,snapshot.models?.find(m=>m.model===control.value)?.efforts||[],value,text(value));}
    }
    status.textContent='';sync();
   };
   control.addEventListener('change',change);if(key===THREAD_LIMIT)control.addEventListener('input',change);
  }
 }
 async function load(message=''){
  if(busy||disposed)return;
  const version=++generation;busy=true;clearPlan();inputs.clear();snapshot=null;fields.replaceChildren();sync();
  status.textContent='正在读取配置…';
  try{
   const data=await read();if(!current(version))return;
   if(!data?.fields||typeof data.fields!=='object')throw Error();
   snapshot=data;unknown=false;renderFields();if(setContextWindow){showModels();windowStatus.textContent='';}
   status.textContent=message||(inputs.size?'已读取当前配置。':'已读取当前配置，当前环境没有可修改的选项。');
  }catch{if(current(version))status.textContent='配置读取失败，可重新读取。';}
  finally{if(current(version)){busy=false;sync();}}
 }
 async function commit(plan){
  if(plan.expiresAt<=clock()){clearPlan();status.textContent='确认已过期，请重新保存。';sync();return;}
  const version=++generation;busy=true;unknown=true;clearPlan();sync();status.textContent='正在保存…';
  let message;
  try{
   const result=await apply({planId:plan.planId,confirmed:true});if(!current(version))return;
   if(result?.outcome==='succeeded'){unknown=false;message=result.status==='okOverridden'?'已写入，更高优先级的配置仍然生效。':'已保存，对新会话生效。';}
   else if(result?.outcome==='not-executed'){unknown=false;message='配置已发生变化，本次未写入。已重新读取。';}
   else throw Error();
  }catch{if(current(version))status.textContent='写入结果未知，请重新读取后再修改。';}
  finally{if(current(version)){busy=false;sync();}}
  if(message&&current(version))await load(message);
 }
 async function saveChanges(){
  if(busy||unknown||disposed||!snapshot)return;
  const edits=changes();if(!edits.length)return;
  if(edits.some(e=>e.key===THREAD_LIMIT&&!(Number.isSafeInteger(e.value)&&e.value>0))){status.textContent='并发线程上限须为正整数。';inputs.get(THREAD_LIMIT)?.focus();return;}
  const version=++generation;busy=true;clearPlan();sync();status.textContent='正在预览更改…';
  let p;
  try{
   p=await plan(edits);if(!current(version))return;
   if(!p?.planId||!Array.isArray(p.diff)||!Number.isFinite(p.expiresAt))throw Error();
  }catch{if(current(version))status.textContent='无法保存，请检查所选值或重新读取配置。';return;}
  finally{if(current(version)){busy=false;sync();}}
  if(!current(version))return;
  if(!p.warnings?.length){await commit(p);return;}
  prepared=p;
  for(const warning of p.warnings)diff.append(node('p',text(warning)));
  status.textContent='请确认权限变更。';sync();confirm.focus();
 }
 refresh.addEventListener('click',()=>load());save.addEventListener('click',saveChanges);
 confirm.addEventListener('click',()=>{if(prepared&&!busy&&!unknown)return commit(prepared);});
 cancel.addEventListener('click',()=>{if(busy||unknown||!snapshot)return;clearPlan();renderFields();status.textContent='已取消修改。';sync();});
 function reset(){generation++;snapshot=null;busy=false;inputs.clear();fields.replaceChildren();clearPlan();status.textContent='';sync();}
 sync();
 return {activate(){if(changes().length||prepared){status.textContent='保留尚未提交的修改。';return;}return load();},reset,destroy(){reset();disposed=true;container.replaceChildren();}};
}
