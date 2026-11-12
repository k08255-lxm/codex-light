import {randomUUID,createHash} from 'node:crypto';
const KEYS=['model','model_reasoning_effort','web_search','approval_policy','sandbox_mode'];
const ENUMS={web_search:['disabled','cached','live','indexed'],approval_policy:['untrusted','on-request','never'],sandbox_mode:['read-only','workspace-write','danger-full-access']};
const REQ={web_search:'allowedWebSearchModes',approval_policy:'allowedApprovalPolicies',sandbox_mode:'allowedSandboxModes'};
const str=s=>typeof s==='string'&&s.length>0&&s.length<=512?s:null;
const absolute=s=>typeof s==='string'&&s.length<=8192&&!/[\0\r\n]/.test(s)&&(/^[A-Za-z]:[\\/]/.test(s)||s.startsWith('/')||/^\\\\[^\\]+\\[^\\]+/.test(s));
const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
const digest=v=>createHash('sha256').update(stable(v)).digest('hex');
const sources={packagedDefaults:'内置默认值',mdm:'组织管理',system:'系统层',enterpriseManaged:'企业管理',user:'用户层',project:'项目层',sessionFlags:'会话覆盖',legacyManagedConfigTomlFromFile:'旧版管理层',legacyManagedConfigTomlFromMdm:'旧版组织管理'};
const managed=new Set(['mdm','system','enterpriseManaged','legacyManagedConfigTomlFromFile','legacyManagedConfigTomlFromMdm']);
const safeValue=(key,value)=>key==='approval_policy'&&value&&typeof value==='object'?{value:null,label:'自定义，只读'}:typeof value==='string'?{value:str(value),label:str(value)??'未知'}:{value:null,label:'默认 / 未提供'};
function userVersion(layers){
 if(!Array.isArray(layers))return null;
 // Protocol response is high-to-low; do not skip a disabled active User layer.
 const active=layers.find(l=>l?.name?.type==='user');
 return active&&active.disabledReason==null?str(active.version):null;
}
export class ConfigSettingsService{
 constructor({rpc,clock=()=>Date.now()}={}){if(!rpc||typeof rpc.call!=='function')throw new TypeError('rpc.call required');this.rpc=rpc;this.clock=clock;this.snapshot=null;this.plans=new Map();this.generation=0;}
 async load(cwd){
  const [configResult,requirementsResult,modelsResult]=await Promise.allSettled([
   this.rpc.call('config/read',{includeLayers:true,...(cwd?{cwd}:{})}),this.rpc.call('configRequirements/read',{}),this.models()
  ]);
  const read=configResult.status==='fulfilled'?configResult.value:null;
  const reqResponse=requirementsResult.status==='fulfilled'?requirementsResult.value:null;
  const requirementsKnown=reqResponse&&Object.hasOwn(reqResponse,'requirements')&&(reqResponse.requirements===null||typeof reqResponse.requirements==='object'&&!Array.isArray(reqResponse.requirements));
  const req=requirementsKnown?reqResponse.requirements:null,models=modelsResult.status==='fulfilled'?modelsResult.value:[];
  const version=userVersion(read?.layers),fields={};
  for(const key of KEYS){
   const raw=read?.config?.[key],value=safeValue(key,raw),origin=read?.origins?.[key]?.name?.type;
   let options=[],readonly=false,reason=null;
   if(!read||!requirementsKnown||!version){readonly=true;reason='配置、约束或有效用户版本不可用';}
   if(key in ENUMS){
    const allowed=req===null?null:req?.[REQ[key]];
    if(req!==null&&!Object.hasOwn(req,REQ[key])){readonly=true;reason='安全约束字段未提供';}
    if(allowed!==null&&!Array.isArray(allowed)){readonly=true;reason='安全约束格式未知';}
    options=allowed===null?[...ENUMS[key]]:Array.isArray(allowed)?ENUMS[key].filter(v=>allowed.includes(v)):[];
    if(!ENUMS[key].includes(raw)){readonly=true;reason=raw&&typeof raw==='object'?'自定义，只读':'当前安全字段未知，只读';}
    if(!options.length){readonly=true;reason='管理策略不允许任何可编辑选项';}
   }else{
    options=key==='model'?models.map(m=>m.model):(models.find(m=>m.model===read?.config?.model)?.efforts??[]);
    if(modelsResult.status!=='fulfilled'){readonly=true;reason='模型目录读取失败';}
    if(managed.has(origin)||req?.models?.newThread?.[key==='model'?'model':'modelReasoningEffort']!=null){readonly=true;reason='模型默认值受管理策略控制';}
    if(key==='model_reasoning_effort'&&!options.length){readonly=true;reason='未确认当前模型可用思考档位';}
   }
   fields[key]={...value,source:sources[origin]??'来源未知',readonly,reason,options:[...new Set(options)]};
  }
  return {cwd:cwd??null,userVersion:version,fields,models,requirementsKnown:!!requirementsKnown,
   requirementsFingerprint:requirementsKnown?digest(req):null};
 }
 async models(){
  const models=[],seen=new Set();let cursor;
  for(let page=0;page<10;page++){
   const response=await this.rpc.call('model/list',{limit:100,...(cursor?{cursor}:{})});
   if(!Array.isArray(response?.data))throw new Error('Model catalog malformed');
   for(const item of response.data){if(!str(item?.model))continue;const efforts=Array.isArray(item.supportedReasoningEfforts)?item.supportedReasoningEfforts.map(e=>str(e?.reasoningEffort)).filter(Boolean):[];if(!seen.has(item.model)){seen.add(item.model);models.push({model:item.model,efforts});}}
   if(response.nextCursor==null)return models;if(!str(response.nextCursor)||response.nextCursor===cursor)throw new Error('Invalid model cursor');cursor=response.nextCursor;
  }throw new Error('Model catalog incomplete');
 }
 projection(snapshot){return {fields:structuredClone(snapshot.fields),models:structuredClone(snapshot.models),requirementsKnown:snapshot.requirementsKnown,hasWritableUserVersion:!!snapshot.userVersion,notice:'只编辑五项用户默认设置；不展示凭据、环境、指令或原始配置。写入不热重载已存在会话。'};}
 async read({cwd}={}){if(cwd!==undefined&&!absolute(cwd))throw new TypeError('Absolute cwd required');const generation=++this.generation;this.plans.clear();const snapshot=await this.load(cwd);if(generation!==this.generation)throw new Error('Config context changed');this.snapshot=snapshot;return this.projection(snapshot);}
 validate(edits,snapshot){
  if(!Array.isArray(edits)||!edits.length||edits.length>5)throw new TypeError('Expected 1–5 field edits');
  const seen=new Set(),values={};
  for(const edit of edits){if(!edit||Object.keys(edit).some(k=>!['key','value'].includes(k))||!KEYS.includes(edit.key)||seen.has(edit.key)||!str(edit.value))throw new TypeError('Invalid or duplicate config edit');seen.add(edit.key);values[edit.key]=edit.value;}
  const targetModel=values.model??snapshot.fields.model.value;
  for(const edit of edits){const field=snapshot.fields[edit.key];if(field.readonly)throw new Error('Config field read-only');const allowed=edit.key==='model_reasoning_effort'?snapshot.models.find(m=>m.model===targetModel)?.efforts??[]:field.options;if(!allowed.includes(edit.value))throw new Error('Config value is not allowed');}
  // A model switch must not silently retain an unsupported explicit effort.
  if(values.model&&!values.model_reasoning_effort&&snapshot.fields.model_reasoning_effort.value&&!snapshot.models.find(m=>m.model===targetModel)?.efforts.includes(snapshot.fields.model_reasoning_effort.value))throw new Error('Select a supported reasoning effort with the model');
  const diff=edits.filter(e=>e.value!==snapshot.fields[e.key].value).map(e=>({key:e.key,from:snapshot.fields[e.key].value,to:e.value,source:snapshot.fields[e.key].source}));
  if(!diff.length)throw new Error('No config changes');return diff;
 }
 plan(edits){
  const snapshot=this.snapshot;if(!snapshot)throw new Error('Read config before planning');
  const diff=this.validate(edits,snapshot),planId=randomUUID(),expiresAt=this.clock()+120000;
  const warnings=['修改共用 Codex 用户配置，可能影响其他客户端和未来任务；现有会话不会热重载。'];
  for(const d of diff){if(d.key==='sandbox_mode')warnings.push(d.to==='danger-full-access'?'危险：关闭文件系统沙盒隔离，命令可能访问更广范围并联网。':d.to==='workspace-write'?'允许写工作区；不代表允许任意目录或自动开启网络。':'将默认沙盒改为只读。');if(d.key==='web_search')warnings.push(d.to==='live'?'在线搜索可能向网络服务发送查询。':d.to==='cached'?'缓存搜索也使用搜索服务，并不等于完全离线。':d.to==='indexed'?'按 Codex 后端 indexed 模式生效，不是禁用；不保证完全离线。':'禁用网页搜索。');if(d.key==='approval_policy')warnings.push(d.to==='never'?'不再询问执行批准；被沙盒拒绝的动作不会因此获得额外权限。':'执行审批行为将变化，请核对所选策略。');}
  this.plans.set(planId,{snapshot:structuredClone(snapshot),diff,edits:structuredClone(edits),expiresAt,generation:this.generation});
  for(const [id,p]of this.plans)if(p.expiresAt<=this.clock())this.plans.delete(id);while(this.plans.size>100)this.plans.delete(this.plans.keys().next().value);
  return {planId,expiresAt,diff,warnings,requiresExplicitConfirmation:true};
 }
 async apply(input){
  if(!input||Object.keys(input).some(k=>!['planId','confirmed'].includes(k))||input.confirmed!==true)throw new TypeError('Explicit confirmation required');
  const plan=this.plans.get(input.planId);if(!plan)throw new Error('Unknown or consumed config plan');this.plans.delete(input.planId);
  if(plan.expiresAt<=this.clock()||plan.generation!==this.generation)throw new Error('Config plan expired or context changed');
  let attempted=false;
  try{
   const fresh=await this.load(plan.snapshot.cwd??undefined);
   if(plan.generation!==this.generation||digest(fresh)!==digest(plan.snapshot))return {outcome:'not-executed',reason:'conflict',notice:'配置版本、约束、来源或可选值已变化；未写入，请重新读取并确认。'};
   this.validate(plan.edits,fresh);attempted=true;this.snapshot=null;this.plans.clear();
   const response=await this.rpc.call('config/batchWrite',{edits:plan.diff.map(d=>({keyPath:d.key,value:d.to,mergeStrategy:'replace'})),expectedVersion:fresh.userVersion,reloadUserConfig:false});
   if(!['ok','okOverridden'].includes(response?.status))throw new Error('Unknown config write result');
   this.snapshot=null;this.plans.clear();
   return {outcome:'succeeded',status:response.status,effective:response.status==='okOverridden'?false:null,notice:response.status==='okOverridden'?'写入已完成，但被更高优先级配置覆盖，不能视为已生效；现有会话未热重载。':'用户配置写入已返回成功；请重新读取核对，新默认值不会热重载现有会话。'};
  }catch{return {outcome:attempted?'unknown':'not-executed',notice:attempted?'写入结果未知，未自动重试。请先读取当前配置核对。':'读取或预检失败，未写入配置。'};}
 }
 clear(){this.generation++;this.snapshot=null;this.plans.clear();}
}
