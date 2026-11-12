// Shared conservative approval subset. Unsupported schema never becomes a free-text form.
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>Object.keys(value).every(key=>allowed.includes(key));
const fail=reason=>({supported:false,reason,options:[],fields:[]});
const safeKey=name=>typeof name==='string'&&name.length>0&&name.length<=160&&!['__proto__','prototype','constructor'].includes(name);
const secret=/password|passwd|secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|credit[ _-]?card|card[ _-]?(number|security)|密码|密钥|银行卡|信用卡|令牌/i;
function safePath(path){return typeof path==='string'&&path.length>0&&path.length<=4096&&!/[\x00-\x1f*?\[\]{}$%~]/.test(path)&&(/^\/(?!\/)/.test(path)||/^[a-zA-Z]:[\\/]/.test(path));}
export function permissionOptions(params){
 const permissions=params?.permissions;if(!object(permissions)||!keys(permissions,['network','fileSystem']))return fail('未知权限结构，不授予扩展权限。');
 const options=[];
 if(permissions.network!=null){if(!object(permissions.network)||!keys(permissions.network,['enabled'])||![true,false,null,undefined].includes(permissions.network.enabled))return fail('未知网络权限结构。');if(permissions.network.enabled===true)options.push({id:'network',kind:'network',label:'允许网络访问'});}
 const fs=permissions.fileSystem;
 if(fs!=null){if(!object(fs)||!keys(fs,['read','write']))return fail('包含 entries、glob 或其他复杂文件权限；此界面不授予。');for(const kind of ['read','write']){const paths=fs[kind];if(paths==null)continue;if(!Array.isArray(paths)||paths.length>64||paths.some(path=>!safePath(path)))return fail('文件权限必须是明确普通绝对路径，不能含特殊位置或通配符。');for(const path of [...new Set(paths)])options.push({id:`${kind}:${options.length}`,kind,path,label:`${kind==='read'?'读取':'写入'} ${path}`});}}
 return {supported:true,options};
}
export function permissionResponse(params,selectedIds){const definition=permissionOptions(params);if(!definition.supported)throw new Error(definition.reason);if(!Array.isArray(selectedIds)||new Set(selectedIds).size!==selectedIds.length||selectedIds.some(id=>!definition.options.some(option=>option.id===id)))throw new Error('只能选择原请求中的权限。');const permissions={};for(const option of definition.options.filter(option=>selectedIds.includes(option.id))){if(option.kind==='network')permissions.network={enabled:true};else{permissions.fileSystem||={};(permissions.fileSystem[option.kind]||=[]).push(option.path);}}return {permissions,scope:'turn'};}
const FORM_KEYS=['type','properties','required','$schema'];
const FIELD_KEYS=['type','title','description','default','enum','enumNames','minLength','maxLength','format','minimum','maximum'];
export function formDefinition(params){
 if(params?.mode!=='form')return fail('不支持此表单或 URL 认证模式；不会执行外部页面或自动授权。');
 const schema=params.requestedSchema;if(!object(schema)||schema.type!=='object'||!keys(schema,FORM_KEYS)||!object(schema.properties))return fail('仅支持明确字段的标准对象表单。');
 const required=schema.required??[];if(!Array.isArray(required)||required.some(name=>!safeKey(name)||!Object.hasOwn(schema.properties,name))||new Set(required).size!==required.length)return fail('必填字段定义无效。');
 const entries=Object.entries(schema.properties);if(entries.length>32)return fail('表单超过 32 个字段，不支持。');const fields=[];
 for(const [name,raw]of entries){
 if(!safeKey(name)||!object(raw)||!keys(raw,FIELD_KEYS)||!['string','number','integer','boolean'].includes(raw.type))return fail('存在未知、嵌套或不支持的字段类型。');
 if(secret.test([name,raw.title,raw.description].filter(v=>typeof v==='string').join(' ')))return fail('此表单可能请求密码、密钥或支付秘密；请使用服务提供的专用认证流程。');
 if((raw.title!==undefined&&(typeof raw.title!=='string'||raw.title.length>1000))||(raw.description!==undefined&&(typeof raw.description!=='string'||raw.description.length>4000)))return fail('字段标题或说明无效。');
 if(raw.enum!==undefined&&(raw.type!=='string'||!Array.isArray(raw.enum)||!raw.enum.length||raw.enum.length>100||raw.enum.some(v=>typeof v!=='string'||v.length>10000)||new Set(raw.enum).size!==raw.enum.length))return fail('只支持字符串枚举。');
 if(raw.enumNames!==undefined&&(!raw.enum||!Array.isArray(raw.enumNames)||raw.enumNames.length!==raw.enum.length||raw.enumNames.some(v=>typeof v!=='string')))return fail('枚举标签无效。');
 for(const key of ['minLength','maxLength'])if(raw[key]!==undefined&&(raw.type!=='string'||!Number.isSafeInteger(raw[key])||raw[key]<0||raw[key]>10000))return fail('字符串长度约束不受支持。');
 for(const key of ['minimum','maximum'])if(raw[key]!==undefined&&(!['number','integer'].includes(raw.type)||!Number.isFinite(raw[key])))return fail('数值范围约束无效。');
 if((raw.minLength??0)>(raw.maxLength??10000)||(raw.minimum??-Infinity)>(raw.maximum??Infinity))return fail('字段范围互相矛盾。');
 if(raw.format!==undefined&&(raw.type!=='string'||!['email','uri','date','date-time'].includes(raw.format)))return fail('此字段格式尚未支持。');
 fields.push({name,...raw,title:raw.title||name,description:raw.description||'',required:required.includes(name)});
 }
 return {supported:true,fields};
}
function validFormat(value,format){if(!format)return true;if(format==='email')return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);if(format==='uri'){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}}if(format==='date'){return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))&&validFormat(value.slice(0,10),'date');}
export function formResponse(params,values){
 const definition=formDefinition(params);if(!definition.supported)throw new Error(definition.reason);if(!object(values)||Object.keys(values).some(key=>!definition.fields.some(field=>field.name===key)))throw new Error('表单包含未知字段。');const entries=[];
 for(const field of definition.fields){let value=values[field.name];if(value===undefined||value===''){if(field.required)throw new Error(`${field.title}：请填写此必填项。`);continue;}
 if(field.type==='string'){if(typeof value!=='string'||(field.required&&!value.trim())||Array.from(value).length<(field.minLength??0)||Array.from(value).length>(field.maxLength??10000)||field.enum&&!field.enum.includes(value)||!validFormat(value,field.format))throw new Error(`${field.title}：格式、长度或选项不符合要求。`);}
 else if(field.type==='boolean'){if(typeof value!=='boolean')throw new Error(`${field.title}：请选择是或否。`);}
 else{if(typeof value!=='number'||!Number.isFinite(value)||field.type==='integer'&&!Number.isSafeInteger(value)||value<(field.minimum??-Infinity)||value>(field.maximum??Infinity))throw new Error(`${field.title}：数值不符合范围或整数要求。`);}
 entries.push([field.name,value]);
 }return {action:'accept',content:Object.fromEntries(entries),_meta:null};
}
