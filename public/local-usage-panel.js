import {estimateTokenCost} from './token-pricing.js';
import {formatUsageNumber,USAGE_UNKNOWN} from './usage-statistics.js';
const str=(v,max=300)=>typeof v==='string'?v.slice(0,max):'';
const safeModel=v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/^(unknown|未知)$/i.test(v)&&!/workbuddy|deepseek|(^|[^a-z])(wb|dsh)([^a-z]|$)/i.test(v);
const codes={'access-denied':'无权读取','file-size-limit':'文件超过上限','total-size-limit':'总读取量超过上限','file-count-limit':'文件数量超过上限','depth-limit':'目录深度超过上限','directory-entry-limit':'目录条目超过上限','compressed-format-unsupported':'压缩文件未覆盖','file-changed-during-read':'读取时文件发生变化','symlink-refused':'已拒绝符号链接','symlink-root-refused':'所选路径含符号链接','parser-diagnostics':'记录解析存在限制','cancelled':'扫描已取消','read-failed':'部分内容读取失败','invalid-utf8':'不是有效 UTF-8','parent-baseline-unresolved':'分支父基线未解析','counter-reset-or-replay':'累计重置或重放','replayed-snapshot':'重复历史快照','continuation-baseline-unresolved':'续页基线未知','initial-baseline-unattributed':'首个累计值未分摊','model-unknown':'模型未知','usage-record-not-supported':'新用量记录格式暂不支持'};
export function localUsageModels(result){
 const models=new Set();
 for(const session of result?.sessions??[]){if(session.attribution!=='observed-differences-only')continue;for(const event of session.increments??[])if(safeModel(event.model))models.add(event.model);}
 return [...models].slice(0,20);
}
// Subtotals cover only complete observed differences from unambiguous local sources.
export function localReferenceEstimates(result, priceByModel) {
 const unique=new Map();
 for(const session of result?.sessions??[]){if(typeof session.threadId!=='string'||typeof session.sourceId!=='string')continue;unique.set(JSON.stringify([session.threadId,session.sourceId]),session);}
 const sources=new Map(),overlap=new Set(result?.overlappingThreadIds??[]);
 for(const session of unique.values()){const previous=sources.get(session.threadId);if(previous!==undefined&&previous!==session.sourceId)overlap.add(session.threadId);sources.set(session.threadId,session.sourceId);}
 const groups=new Map();let excludedSessions=0;
 for(const session of unique.values()){
  if(session.attribution!=='observed-differences-only'||overlap.has(session.threadId)){excludedSessions++;continue;}
  const seen=new Set();
  for(const event of session.increments??[]){
   if(event.kind!=='observed-cumulative-difference'||!safeModel(event.model))continue;
   if(!groups.has(event.model))groups.set(event.model,{model:event.model,estimatedUsd:null,estimatedEntries:0,unknownEntries:0});
   const group=groups.get(event.model);
   if(!Number.isSafeInteger(event.record)||event.record<1){group.unknownEntries++;continue;}
   if(seen.has(event.record))continue;seen.add(event.record);
   let estimate;
   const price=priceByModel instanceof Map?priceByModel.get(event.model):undefined;
   try{if(price?.model===event.model)estimate=estimateTokenCost({...event.tokens,model:event.model},price);}catch{/* Unknown policy/price: no guessed cost. */}
   if(!estimate?.complete){group.unknownEntries++;continue;}
   const sum=(group.estimatedUsd??0)+estimate.usd;
   if(!Number.isFinite(sum)){group.unknownEntries++;continue;}
   group.estimatedUsd=sum;group.estimatedEntries++;
  }
 }
 return {groups:[...groups.values()],excludedSessions,notice:'仅可估部分参考金额，不是完整历史、订阅账单或实际扣款；不与官方统计相加。'};
}
export function mountLocalUsagePanel(container,{api}){
 const doc=container.ownerDocument;let generation=0,disposed=false,result=null,busy=false;
 const el=(tag,text,cls)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
 const heading=el('h2','本地 Codex 记录'),notice=el('p','仅在点击后只读扫描所选本机目录的 Codex token 记录；原始消息内容不会上传。结果仅表示所选文件覆盖范围，不与官方统计相加。','local-usage-note');
 const label=el('label','绝对目录路径'),input=el('input');input.type='text';input.placeholder='输入你授权扫描的绝对目录';input.autocomplete='off';input.spellcheck=false;label.append(input);
 const controls=el('div',undefined,'local-usage-controls'),scan=el('button','扫描所选目录'),stop=el('button','停止等待'),prices=el('button','刷新参考价格（联网）');
 for(const b of [scan,stop,prices])b.type='button';controls.append(scan,stop,prices);
 const status=el('p','尚未扫描。','local-usage-status');status.setAttribute('role','status');
 const output=el('div',undefined,'local-usage-results'),pricing=el('div',undefined,'local-usage-pricing');
 container.replaceChildren(heading,notice,label,controls,status,output,pricing);container.classList.add('local-usage-panel');
 function state(value){busy=value;scan.disabled=value;prices.disabled=value||!result;stop.disabled=!value;container.setAttribute('aria-busy',String(value));}
 function table(caption,headers,rows){const t=el('table',undefined,'local-usage-table');t.append(el('caption',caption));const head=el('thead'),tr=el('tr');for(const h of headers){const th=el('th',h);th.setAttribute('scope','col');tr.append(th);}head.append(tr);t.append(head);const body=el('tbody');for(const row of rows){const tr=el('tr');row.forEach((v,i)=>{const td=el(i?'td':'th',v);if(!i)td.setAttribute('scope','row');tr.append(td);});body.append(tr);}t.append(body);return t;}
 function render(data){
  output.replaceChildren();
  output.append(el('p',data.partial?'扫描覆盖不完整：存在跳过、限制或解析问题。':'所选目录扫描结束；这不代表完整账户历史。'),el('p',`成功读取 ${formatUsageNumber(data.filesRead)} 个文件，读取 ${formatUsageNumber(data.bytesRead)} 字节。仅未压缩 JSONL，不含官方接口数据。`));
  const diagnostics=Object.entries(data.diagnosticCounts??{}).slice(0,30).map(([code,count])=>[codes[code]??'其他扫描限制',formatUsageNumber(count)]);
  if(diagnostics.length)output.append(table('扫描诊断摘要',['情况','数量'],diagnostics));
  const sessions=Array.isArray(data.sessions)?data.sessions.slice(0,100):[];
  if(!sessions.length){output.append(el('p','未得到可识别线程的统计；不能将其视作用量为零。'));return;}
  for(const notice of new Set(sessions.map(s=>s.compatibilityNotice).filter(x=>typeof x==='string')))output.append(el('p',str(notice)));
  if(data.sessions.length>100)output.append(el('p','仅显示前 100 个来源快照，未据此合计。'));
  if(data.overlappingThreadIds?.length)output.append(el('p','存在同一线程的多个来源，以下分别展示，不相加。'));
  output.append(table('线程 / 来源的最新观察快照（不是新增用量）',['线程','来源','累计 tokens','归属状态'],sessions.map(s=>[str(s.threadId)||USAGE_UNKNOWN,str(s.sourceId)||USAGE_UNKNOWN,formatUsageNumber(s.snapshot?.totalTokens),s.attribution==='deferred'?'不确定，暂不归属':'仅已观察的差值'])));
  const rows=[];let deferred=false,totalRows=0;
  for(const s of sessions){
   if(s.attribution!=='observed-differences-only'){deferred=true;continue;}
   for(const e of Array.isArray(s.increments)?s.increments:[]){if(e.kind!=='observed-cumulative-difference')continue;totalRows++;if(rows.length<100)rows.push([str(s.threadId),str(e.timestamp)||USAGE_UNKNOWN,safeModel(e.model)?e.model:'未知 / 不估价',formatUsageNumber(e.tokens?.inputTokens),formatUsageNumber(e.tokens?.cachedInputTokens),formatUsageNumber(e.tokens?.outputTokens),formatUsageNumber(e.tokens?.totalTokens)]);}
  }
  if(deferred)output.append(el('p','存在归属未确定的历史；未将其计作零，也未估算费用。'));
  if(rows.length)output.append(table('安全观察到的累计差值（模型仅依据当时上下文）',['线程','记录时间','模型','输入','缓存输入','输出','总 tokens'],rows));
  else output.append(el('p','没有可展示的确定差值；首个累计快照仅作基线，不据此猜测新增用量。'));
  if(totalRows>100)output.append(el('p','仅显示前 100 个差值，不据此计算合计费用。'));
 }
 async function start(){
  if(busy||disposed)return;
  const directory=input.value.trim();
  if(!directory||directory.length>8192||/[\0\r\n]/.test(directory)||!(/^[A-Za-z]:[\\/]/.test(directory)||directory.startsWith('/')||/^\\\\[^\\]+\\[^\\]+/.test(directory))){status.textContent='请输入你授权扫描的绝对目录。';input.focus();return;}
  const version=++generation;result=null;output.replaceChildren();pricing.replaceChildren();state(true);status.textContent='正在只读扫描所选目录…';
  try{const data=await api('/api/local-usage/scan',{directory});if(disposed||version!==generation)return;result=data;render(data);status.textContent='扫描完成，请留意覆盖范围与诊断。';}
  catch{if(!disposed&&version===generation)status.textContent='扫描失败，未自动重试；请检查所选目录和访问权限。';}
  finally{if(!disposed&&version===generation)state(false);}
 }
 async function refreshPrices(){
  if(busy||disposed||!result)return;
  const version=++generation,models=localUsageModels(result);state(true);pricing.replaceChildren();status.textContent='正在从 models.dev 获取参考目录；不会发送本地消息原文。';
  try{
   const info=await api('/api/pricing/refresh',{});if(disposed||version!==generation)return;
   pricing.append(el('p',`参考来源：models.dev；同步时间：${str(info?.fetchedAt)||USAGE_UNKNOWN}。社区参考价，不是账单；同步时间不是价格生效时间。`));
   const rows=[],priceMap=new Map();
   for(const model of models){const p=await api('/api/pricing/model',{model});if(disposed||version!==generation)return;priceMap.set(model,p);const rate=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0?String(n):USAGE_UNKNOWN;rows.push([model,rate(p?.input),rate(p?.cacheRead),rate(p?.output)]);}
   if(rows.length)pricing.append(table('最多 20 个确定模型的参考单价（USD / 百万 tokens）',['模型','输入','缓存读取','输出'],rows));
   else pricing.append(el('p','没有已归属的已知模型，仅显示价格来源信息。'));
   const estimates=localReferenceEstimates(result,priceMap);
   if(estimates.groups.length)pricing.append(table('已观察差值的可估部分（非完整历史）',['模型','可估部分参考美元','已估条目','未知条目'],estimates.groups.map(g=>[g.model,g.estimatedUsd===null?USAGE_UNKNOWN:String(g.estimatedUsd),formatUsageNumber(g.estimatedEntries),formatUsageNumber(g.unknownEntries)])));
   if(estimates.excludedSessions)pricing.append(el('p','归属未定或跨来源重叠的线程已排除，不作零费用。'));
   pricing.append(el('p',estimates.notice));status.textContent='参考价格查询完成。';
  }catch{if(!disposed&&version===generation)status.textContent='参考价格查询未完成，未自动重试。';}
  finally{if(!disposed&&version===generation)state(false);}
 }
 scan.addEventListener('click',start);prices.addEventListener('click',refreshPrices);
 stop.addEventListener('click',()=>{if(!busy)return;++generation;state(false);status.textContent='已停止等待；后台扫描或价格请求可能仍在运行，未确认已取消。';scan.focus();});
 input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();start();}});
 state(false);
 return {reset(){++generation;result=null;input.value='';output.replaceChildren();pricing.replaceChildren();state(false);status.textContent='尚未扫描。';},deactivate(){++generation;state(false);status.textContent='已离开当前等待；后台请求可能仍在运行。';},destroy(){++generation;disposed=true;container.replaceChildren();}};
}
