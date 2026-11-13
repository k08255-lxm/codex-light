// Shared conservative approval subset. Unsupported schema never becomes a free-text form.
// Used by the browser UI and by the server-side response validator (src/security.mjs).
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>Object.keys(value).every(key=>allowed.includes(key));
const fail=reason=>({supported:false,reason,options:[],restrictions:[],fields:[],questions:[]});
const safeKey=name=>typeof name==='string'&&name.length>0&&name.length<=160&&!['__proto__','prototype','constructor'].includes(name);
const withoutNulls=value=>Object.fromEntries(Object.entries(value).filter(([,entry])=>entry!==null));
const secret=/password|passwd|secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|credit[ _-]?card|card[ _-]?(number|security)|密码|密钥|银行卡|信用卡|令牌/i;
function safePath(path){return typeof path==='string'&&path.length>0&&path.length<=4096&&!/[\x00-\x1f*?\[\]{}$%~]/.test(path)&&!/(^|[\\/])\.{1,2}(?=[\\/]|$)/.test(path)&&(/^\/(?!\/)/.test(path)||/^[a-zA-Z]:[\\/]/.test(path));}

// JSON-RPC ids: integer 1 and string "1" are different requests.
export const validRequestId=id=>typeof id==='string'||Number.isSafeInteger(id);
export const requestKey=id=>JSON.stringify([typeof id,id]);
export const requestThread=request=>request?.params?.threadId??request?.params?.conversationId??null;

// Exact protocol decisions, shared by renderer and response validation. Never synthesize a rule.
export function approvalDecisions(method, params={}) {
 const command=method==='item/commandExecution/requestApproval',file=method==='item/fileChange/requestApproval';
 const legacy=method==='execCommandApproval'||method==='applyPatchApproval';
 if(!command&&!file&&!legacy)return [];
 if(command&&!['command','writeStdin','humanCommand'].includes(params.kind??'command'))return [];
 const listed=Array.isArray(params.availableDecisions)?params.availableDecisions:null;
 const available=value=>!listed||listed.includes(value);
 const choices=[];
 const add=(id,label,decision,scope,rule=null)=>choices.push({id,label,decision,scope,rule});
 if(legacy){
  if(available('approved'))add('once','允许一次','approved','只批准当前操作。');
  if(requestThread({params})&&available('approved_for_session'))add('session','本对话允许','approved_for_session','由 Codex 在当前会话的审批缓存中记住此选择；不修改全局权限。');
 }else{
  if(available('accept'))add('once','允许一次','accept','只批准当前操作。');
  if(requestThread({params})&&(params.kind??'command')!=='humanCommand'&&available('acceptForSession'))add('session','本对话允许','acceptForSession',file?'当前会话内对相同文件的后续修改免重复审批。':'由 Codex 在当前会话的审批缓存中记住此选择；不修改全局权限。');
 }
 const validRule=value=>Array.isArray(value)&&value.length>0&&value.length<=128&&value.every(part=>typeof part==='string'&&part.length>0&&part.length<=20000&&!part.includes('\0'));
 if(command&&(params.kind??'command')==='command'){
  const proposed=params.proposedExecpolicyAmendment;
  const offered=(listed||[]).filter(value=>object(value)&&Object.keys(value).length===1&&object(value.acceptWithExecpolicyAmendment)&&Object.keys(value.acceptWithExecpolicyAmendment).join(',')==='execpolicy_amendment').map(value=>value.acceptWithExecpolicyAmendment.execpolicy_amendment);
  const rules=listed?offered:validRule(proposed)?[proposed]:[];
  for(const rule of rules){
   if(!validRule(rule)||(proposed!=null&&(!validRule(proposed)||rule.length!==proposed.length||rule.some((part,index)=>part!==proposed[index]))))continue;
   if(choices.some(choice=>choice.rule&&JSON.stringify(choice.rule)===JSON.stringify(rule)))continue;
   add('rule:'+choices.length,'始终允许',{acceptWithExecpolicyAmendment:{execpolicy_amendment:[...rule]}},'保存 Codex 提议的命令前缀规则，未来匹配此规则的命令可免审批。仅应用下方规则。',[...rule]);
  }
 }
 // Legacy request schemas carry no proposed rule; do not invent a permanent amendment.
 return choices;
}

// Permissions: network on/off, legacy absolute read/write roots, or modern `entries` with plain absolute paths.
// Deny entries are mandatory restrictions: never options, always kept next to any filesystem grant.
export function permissionOptions(params){
 const permissions=params?.permissions;if(!object(permissions)||!keys(permissions,['network','fileSystem']))return fail('未知权限结构，不授予扩展权限。');
 const options=[],restrictions=[];let mode=null,entries=[];
 if(permissions.network!=null){if(!object(permissions.network)||!keys(permissions.network,['enabled'])||![true,false,null,undefined].includes(permissions.network.enabled))return fail('未知网络权限结构。');if(permissions.network.enabled===true)options.push({id:'network',kind:'network',label:'允许网络访问'});}
 const fs=object(permissions.fileSystem)?withoutNulls(permissions.fileSystem):permissions.fileSystem;
 if(fs!=null){
  if(!object(fs)||!keys(fs,['read','write','entries']))return fail('包含 glob 扫描或其他复杂文件权限；此界面不授予。');
  const legacy={};
  for(const kind of ['read','write']){const paths=fs[kind];if(paths==null)continue;if(!Array.isArray(paths)||paths.length>64||paths.some(path=>!safePath(path)))return fail('文件权限必须是明确普通绝对路径，不能含特殊位置或通配符。');legacy[kind]=[...new Set(paths)];}
  if(fs.entries!=null){
   if(!Array.isArray(fs.entries)||fs.entries.length>128)return fail('文件权限条目无效。');
   const seen=new Set();
   for(const entry of fs.entries){
    if(!object(entry)||!keys(entry,['access','path'])||!['read','write','deny'].includes(entry.access)||!object(entry.path)||!keys(entry.path,['type','path'])||entry.path.type!=='path'||!safePath(entry.path.path))return fail('文件权限只支持明确的普通绝对路径；通配符、特殊位置或未知条目不授予。');
    const id=entry.access+'\u0000'+entry.path.path;if(seen.has(id))continue;seen.add(id);entries.push({access:entry.access,path:entry.path.path});
   }
   for(const row of entries)if(row.access==='deny'&&entries.some(other=>other.access!=='deny'&&other.path===row.path))return fail('同一路径同时被请求允许和禁止，不授予。');
   // Servers may mirror legacy-compatible entries into read/write; both forms must agree exactly.
   if(fs.read!=null||fs.write!=null){const same=(kind)=>{const a=entries.filter(row=>row.access===kind).map(row=>row.path),b=legacy[kind]||[];return a.length===b.length&&a.every(path=>b.includes(path));};if(entries.some(row=>row.access==='deny')||!same('read')||!same('write'))return fail('文件权限的新旧格式不一致，不授予。');}
   entries.forEach((row,index)=>{if(row.access==='deny')restrictions.push({path:row.path,label:'禁止访问 '+row.path});else options.push({id:`entry:${index}`,kind:row.access,path:row.path,entry:index,label:`${row.access==='read'?'读取':'写入'} ${row.path}`});});
   mode='entries';
  }else{for(const kind of ['read','write'])for(const path of legacy[kind]||[])options.push({id:`${kind}:${options.length}`,kind,path,label:`${kind==='read'?'读取':'写入'} ${path}`});mode='legacy';}
 }
 return {supported:true,options,restrictions,mode,entries};
}
export function permissionResponse(params,selectedIds,scope='turn'){
 if(!['turn','session'].includes(scope))throw new Error('权限范围无效。');
 const definition=permissionOptions(params);if(!definition.supported)throw new Error(definition.reason);
 if(!Array.isArray(selectedIds)||new Set(selectedIds).size!==selectedIds.length||selectedIds.some(id=>!definition.options.some(option=>option.id===id)))throw new Error('只能选择原请求中的权限。');
 const chosen=definition.options.filter(option=>selectedIds.includes(option.id));const permissions={};
 if(chosen.some(option=>option.kind==='network'))permissions.network={enabled:true};
 const files=chosen.filter(option=>option.kind!=='network');
 if(files.length){
  if(definition.mode==='entries'){const picked=new Set(files.map(option=>option.entry));permissions.fileSystem={entries:definition.entries.filter((row,index)=>row.access==='deny'||picked.has(index)).map(row=>({access:row.access,path:{type:'path',path:row.path}}))};}
  else{permissions.fileSystem={};for(const option of files)(permissions.fileSystem[option.kind]||=[]).push(option.path);}
 }
 return {permissions,scope};
}

// MCP elicitation forms: primitive fields only (string, number/integer, boolean, single/multi select).
const FORM_KEYS=['type','properties','required','$schema'];
const BASE=['type','title','description','default'];
const FIELD_KEYS={string:[...BASE,'enum','enumNames','oneOf','minLength','maxLength','format'],number:[...BASE,'minimum','maximum'],integer:[...BASE,'minimum','maximum'],boolean:BASE,array:[...BASE,'items','minItems','maxItems']};
function constOptions(list){if(!Array.isArray(list)||!list.length||list.length>100||list.some(option=>!object(option)||!keys(option,['const','title'])||typeof option.const!=='string'||typeof option.title!=='string'||option.const.length>10000||option.title.length>1000)||new Set(list.map(option=>option.const)).size!==list.length)return null;return list.map(option=>({value:option.const,label:option.title||option.const}));}
function enumOptions(values,names){if(!Array.isArray(values)||!values.length||values.length>100||values.some(value=>typeof value!=='string'||value.length>10000)||new Set(values).size!==values.length)return null;if(names!==undefined&&(!Array.isArray(names)||names.length!==values.length||names.some(name=>typeof name!=='string')))return null;return values.map((value,index)=>({value,label:names?.[index]||value}));}
function parseField(name,source,required){
 if(!safeKey(name)||!object(source))return '存在未知、嵌套或不支持的字段类型。';
 const raw=withoutNulls(source);
 if(!Object.hasOwn(FIELD_KEYS,raw.type)||!keys(raw,FIELD_KEYS[raw.type]))return '存在未知、嵌套或不支持的字段类型。';
 if(secret.test([name,raw.title,raw.description].filter(value=>typeof value==='string').join(' ')))return '此表单可能请求密码、密钥或支付秘密；请使用服务提供的专用认证流程。';
 if((raw.title!==undefined&&(typeof raw.title!=='string'||raw.title.length>1000))||(raw.description!==undefined&&(typeof raw.description!=='string'||raw.description.length>4000)))return '字段标题或说明无效。';
 const field={name,type:raw.type,title:raw.title||name,description:raw.description||'',required};
 if(raw.type==='string'){
  if(raw.enum!==undefined&&raw.oneOf!==undefined)return '字段选项定义冲突。';
  if(raw.enumNames!==undefined&&raw.enum===undefined)return '枚举标签无效。';
  if(raw.enum!==undefined||raw.oneOf!==undefined){field.options=raw.enum!==undefined?enumOptions(raw.enum,raw.enumNames):constOptions(raw.oneOf);if(!field.options)return '只支持字符串选项。';if(['minLength','maxLength','format'].some(key=>raw[key]!==undefined))return '选项字段不能带文本约束。';}
  for(const key of ['minLength','maxLength'])if(raw[key]!==undefined&&(!Number.isSafeInteger(raw[key])||raw[key]<0||raw[key]>10000))return '字符串长度约束不受支持。';
  if((raw.minLength??0)>(raw.maxLength??10000))return '字段范围互相矛盾。';
  if(raw.format!==undefined&&!['email','uri','date','date-time'].includes(raw.format))return '此字段格式尚未支持。';
  Object.assign(field,{minLength:raw.minLength,maxLength:raw.maxLength,format:raw.format});
 }else if(raw.type==='number'||raw.type==='integer'){
  for(const key of ['minimum','maximum'])if(raw[key]!==undefined&&!Number.isFinite(raw[key]))return '数值范围约束无效。';
  if((raw.minimum??-Infinity)>(raw.maximum??Infinity))return '字段范围互相矛盾。';
  Object.assign(field,{minimum:raw.minimum,maximum:raw.maximum});
 }else if(raw.type==='array'){
  const items=object(raw.items)?raw.items:null;
  if(!items)return '多选字段缺少选项。';
  if(keys(items,['type','enum'])&&items.type==='string'&&Object.keys(items).length===2)field.options=enumOptions(items.enum);
  else if(keys(items,['anyOf'])&&Object.keys(items).length===1)field.options=constOptions(items.anyOf);
  if(!field.options)return '只支持字符串多选。';
  for(const key of ['minItems','maxItems'])if(raw[key]!==undefined&&(!Number.isSafeInteger(raw[key])||raw[key]<0))return '多选数量约束无效。';
  if((raw.minItems??0)>(raw.maxItems??Infinity)||(raw.minItems??0)>field.options.length)return '字段范围互相矛盾。';
  Object.assign(field,{multiple:true,minItems:raw.minItems,maxItems:raw.maxItems});
 }
 return field;
}
// `openai/form` and `openaiForm` carry the same object schema; only explicitly supported primitives are rendered.
export const FORM_MODES=Object.freeze(['form','openai/form','openaiForm']);
export function formDefinition(params){
 if(!FORM_MODES.includes(params?.mode))return fail('不支持此表单或 URL 认证模式；不会执行外部页面或自动授权。');
 // Privileged approval kinds other than an MCP tool call need their own verified flow (backend rejects accept too).
 const meta=params._meta;if(object(meta)&&Object.hasOwn(meta,'codex_approval_kind')&&meta.codex_approval_kind!=='mcp_tool_call')return fail('这类请求需要专用流程，此界面只能拒绝或取消。');
 const schema=object(params.requestedSchema)?withoutNulls(params.requestedSchema):null;
 if(!schema||schema.type!=='object'||!keys(schema,FORM_KEYS)||!object(schema.properties))return fail('仅支持明确字段的标准对象表单。');
 const required=schema.required??[];if(!Array.isArray(required)||required.some(name=>!safeKey(name)||!Object.hasOwn(schema.properties,name))||new Set(required).size!==required.length)return fail('必填字段定义无效。');
 const entries=Object.entries(schema.properties);if(entries.length>32)return fail('表单超过 32 个字段，不支持。');const fields=[];
 for(const [name,raw]of entries){const field=parseField(name,raw,required.includes(name));if(typeof field==='string')return fail(field);fields.push(field);}
 return {supported:true,fields,messageOnly:!fields.length};
}
function validFormat(value,format){if(!format)return true;if(format==='email')return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);if(format==='uri'){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}}if(format==='date'){return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))&&validFormat(value.slice(0,10),'date');}
const fieldError=(field,message)=>Object.assign(new Error(`${field.title}：${message}`),{field:field.name});
export function formResponse(params,values){
 const definition=formDefinition(params);if(!definition.supported)throw new Error(definition.reason);
 // Message-only (empty schema) requests are a plain allow with empty content; nothing else may be added.
 if(definition.messageOnly){if(values!=null&&(!object(values)||Object.keys(values).length))throw new Error('表单包含未知字段。');return {action:'accept',content:{},_meta:null};}
 if(!object(values)||Object.keys(values).some(key=>!definition.fields.some(field=>field.name===key)))throw new Error('表单包含未知字段。');const entries=[];
 for(const field of definition.fields){
  const value=values[field.name];
  // An explicit [] is a value (valid when minItems allows it), not a missing property.
  if(value===undefined||(!field.multiple&&value==='')){if(field.required)throw fieldError(field,'请填写此必填项。');continue;}
  if(field.multiple){if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!field.options.some(option=>option.value===item))||new Set(value).size!==value.length)throw fieldError(field,'只能选择列出的选项。');if(value.length<(field.minItems??0)||value.length>(field.maxItems??Infinity))throw fieldError(field,'选择数量不符合要求。');}
  else if(field.type==='string'){if(typeof value!=='string')throw fieldError(field,'格式、长度或选项不符合要求。');if(field.options){if(!field.options.some(option=>option.value===value))throw fieldError(field,'只能选择列出的选项。');}else if((field.required&&!value.trim())||Array.from(value).length<(field.minLength??0)||Array.from(value).length>(field.maxLength??10000)||!validFormat(value,field.format))throw fieldError(field,'格式、长度或选项不符合要求。');}
  else if(field.type==='boolean'){if(typeof value!=='boolean')throw fieldError(field,'请选择是或否。');}
  else{if(typeof value!=='number'||!Number.isFinite(value)||field.type==='integer'&&!Number.isSafeInteger(value)||value<(field.minimum??-Infinity)||value>(field.maximum??Infinity))throw fieldError(field,'数值不符合范围或整数要求。');}
  entries.push([field.name,value]);
 }
 return {action:'accept',content:Object.fromEntries(entries),_meta:null};
}

// request_user_input: options, optional custom "other" text, secret (masked) answers. Every id is answered;
// an empty array means the user skipped that question. Non-empty answers keep the exact text typed.
export function userInputDefinition(params){
 const questions=params?.questions;
 if(!Array.isArray(questions)||!questions.length||questions.length>20)return fail('问题列表无效。');
 const rows=[];
 for(const q of questions){
  if(!object(q)||!safeKey(q.id)||rows.some(row=>row.id===q.id))return fail('问题标识无效或重复。');
  for(const key of ['header','question'])if(q[key]!=null&&(typeof q[key]!=='string'||q[key].length>4000))return fail('问题文本无效。');
  const options=q.options??[];
  if(!Array.isArray(options)||options.length>50||options.some(option=>!object(option)||typeof option.label!=='string'||!option.label||option.label.length>1000||(option.description!=null&&typeof option.description!=='string'))||new Set(options.map(option=>option.label)).size!==options.length)return fail('问题选项无效。');
  rows.push({id:q.id,header:q.header||'',question:q.question||q.header||q.id,secret:q.isSecret===true,other:q.isOther===true&&options.length>0,options:options.map(option=>({label:option.label,description:option.description||''}))});
 }
 return {supported:true,questions:rows};
}
// values: {[questionId]: string|null|undefined}. Missing/empty means skipped.
export function userInputResponse(params,values){
 const definition=userInputDefinition(params);if(!definition.supported)throw new Error(definition.reason);
 if(!object(values)||Object.keys(values).some(key=>!definition.questions.some(q=>q.id===key)))throw new Error('回答包含未知问题。');
 const answers={};
 for(const q of definition.questions){
  const value=values[q.id];
  const skipped=value==null||value===''||(!q.secret&&typeof value==='string'&&!value.trim());
  if(skipped){answers[q.id]={answers:[]};continue;}
  if(typeof value!=='string'||value.length>20000)throw new Error(`${q.header||q.question}：回答过长或无效。`);
  if(q.options.length&&!q.other&&!q.options.some(option=>option.label===value))throw new Error(`${q.header||q.question}：只能选择列出的选项。`);
  answers[q.id]={answers:[value]};
 }
 return {answers};
}
