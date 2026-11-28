// Usage & performance analytics. Strictly follows STATISTICS-CONTRACT: POST /api/statistics/query|import.
// Light (observed by this app) and Local (imported Codex logs) are separate scopes and never summed.
import { el, compact, integer, percent, usd, seconds, rate, localTime, windowLabel, UNKNOWN } from './format.js';
import { barChart } from './chart.js';
import { icon } from '../icons.js';
import {initialRange,mountUsageRange,usageBounds} from './usage-range.js';
import {mountStatPopover} from './stat-popover.js';

const METRICS = {
  tokens: { label: 'Tokens', value: row => row.totalTokens, format: compact },
  output: { label: '输出 Tokens', value: row => row.outputTokens, format: compact },
  turns: { label: '回合', value: row => row.turnCount, format: integer },
  cost: { label: '费用', value: row => row.estimatedCost?.usd ?? null, format: usd },
};
const STATUS = { completed: '完成', failed: '失败', interrupted: '已停止', inProgress: '进行中', unknown: '未知' };

/**
 * Builds a query body from UI state. `to` is exclusive; `from` inclusive (contract).
 * The time window is anchored at `ui.anchor` (fixed per fresh query) because backend cursors
 * are bound to the exact filters: every page of one query must send identical from/to.
 */
export function statisticsQuery(ui, now = ui.anchor ?? Date.now()) {
  const {start,end,bucket}=usageBounds(ui,now);
  const body = { scope: ui.scope === 'local' ? 'local' : 'light', bucket, limit: 30 };
  if(start!==null)body.from=new Date(start).toISOString();
  // Our query uses an exclusive upper bound. Include the selected instant.
  body.to=new Date(end+1).toISOString();
  if (ui.model) body.model = ui.model;
  if (ui.account) body.account = ui.account;
  if (ui.cursor) body.cursor = ui.cursor;
  return body;
}

/** Short description of how much of the cost is actually priced. */
export function costCoverage(cost) {
  if (!cost?.totalRows || cost.complete) return '';
  const known=cost.pricedRows??0;
  if(!known)return '这些记录缺少用量或匹配的单价；展开明细中的费用可查看原因。';
  return `费用包含 ${integer(known)} / ${integer(cost.totalRows)} 条记录${cost.partialRows?'，其中 '+integer(cost.partialRows)+' 条仅包含部分用量':''}。`;
}

const COST_PARTS={input:'未缓存输入',inputIncludingCacheWrite:'输入（含缓存写入）',cacheRead:'缓存读取',cacheWrite:'缓存写入',output:'输出',reasoning:'推理输出'};
export function costCompletenessReason(cost){const missing=(cost?.components||[]).filter(p=>p.usd==null).map(p=>`${COST_PARTS[p.kind]||p.kind}${p.tokens==null?'计数缺失':p.pricePerMillion==null?'单价缺失':'无法计价'}`);return missing.length?missing.join('、'):(cost?.reason||(cost?.pricingComplete?'计价分项已齐全，但观察记录未确认覆盖整个回合。':'部分计数或参考单价尚未取得，当前仅显示已知分项小计。'));}

export function mountStatistics(host, { api, notice = () => {}, onPickFolder = null, readQuota = null }) {
  const document = host.ownerDocument;
  const ui = { scope: 'light', range: initialRange(document.defaultView?.localStorage), metric: 'tokens', tab: 'details', model: '', account: '', cursor: null, history: [], sort: null, anchor: null };
  let data = null, dataBucket='day', loading = false, generation = 0, active = false, importing = false, discovered = false, localImported = false, importingPrices=false;
  let rangeClock=null;
  let liveRefresh=null;
  let quotaGeneration=0;
  let quotaRead=null,quotaWindows=[];
  function latestResetStart(){
    const now=Date.now();
    const starts=quotaWindows.filter(w=>Number.isFinite(w.startsAt)&&w.startsAt*1000<=now&&now<w.resetsAt*1000).map(w=>w.startsAt*1000);
    return starts.length?Math.max(...starts):null;
  }
  function usageUpdated(){
    if(!active||ui.scope!=='light'||ui.cursor||liveRefresh!==null)return;
    liveRefresh=setTimeout(()=>{
      liveRefresh=null;
      if(!active||ui.scope!=='light'||ui.cursor||importing)return;
      if(loading){usageUpdated();return;}
      ui.anchor=null;void load('',true);
    },120);
  }
  function syncRangeClock(){
    clearInterval(rangeClock);rangeClock=null;
    if(active&&(ui.range==='reset'||ui.range==='custom'&&ui.liveEnd))rangeClock=setInterval(()=>{
      if(!ui.cursor&&!loading&&!importing&&document.visibilityState!=='hidden'){ui.anchor=null;void load();}
    },60000);
  }

  host.classList.add('stats');
  const header = el(document, 'header', 'page-head');
  const titles = el(document, 'div', 'page-titles');
  titles.append(el(document, 'h1', '', '用量与性能'), el(document, 'p', 'page-sub', ''));
  const controls = el(document, 'div', 'page-controls');
  const scope = segmented([['light', '本应用观测'], ['local', 'Codex 日志']], ui.scope, value => {
    ui.scope = value; ui.model = ''; ui.account=''; resetPaging();
    if (value === 'local' && !localImported) discoverAndImport(); else load();
  });
  const range = mountUsageRange(document,ui,value=>{Object.assign(ui,value);resetPaging();syncRangeClock();load();},
    {boundary:header,readResetStart:latestResetStart,onOpen:refreshBalance});
  const refresh = el(document, 'button', 'btn icon-only'); refresh.type = 'button'; refresh.title = '刷新'; refresh.setAttribute('aria-label', '刷新统计'); refresh.append(icon(document, 'refresh', { size: 16 }));
  refresh.addEventListener('click', () => { resetPaging(); void refreshBalance(); if (ui.scope === 'local' && importInput.value.trim()) importDirectory(); else load(); });
  const priceImport=el(document,'button','btn small','导入 models.dev 价格');priceImport.type='button';priceImport.title='显式获取公共参考单价，不发送对话或账户信息';
  priceImport.addEventListener('click',async()=>{
    if(importingPrices)return;importingPrices=true;priceImport.disabled=true;priceImport.setAttribute('aria-busy','true');
    try{const result=await api('/api/pricing/refresh',{});resetPaging();await load();setStatus(`已导入 ${integer(result.modelCount)} 个模型参考价格${result.persistenceWarning?'；'+result.persistenceWarning:''}`);}
    catch(error){setStatus('价格导入失败：'+error.message,true);}
    finally{importingPrices=false;priceImport.disabled=false;priceImport.removeAttribute('aria-busy');}
  });
  const priceSettings=el(document,'button','btn small','价格设置');priceSettings.type='button';
  priceSettings.addEventListener('click',()=>{pricePanel.open=!pricePanel.open;if(pricePanel.open)priceModel.focus();});
  controls.append(scope.node, range.trigger, range.panel, priceImport, priceSettings, refresh);
  header.append(titles, controls);

  const importBar = el(document, 'form', 'import-bar hidden');
  const importInput = el(document, 'input'); importInput.placeholder = '选择或输入 Codex sessions 目录，例如 C:\\Users\\you\\.codex\\sessions'; importInput.setAttribute('aria-label', '日志目录');
  const importPick = el(document, 'button', 'btn', '选择文件夹…'); importPick.type = 'button';
  const importGo = el(document, 'button', 'btn primary', '导入'); importGo.type = 'submit';
  importBar.append(icon(document, 'folder', { size: 16 }), importInput, importPick, importGo);
  importPick.hidden = !onPickFolder;
  importPick.addEventListener('click', async () => { try { const path = await onPickFolder(); if (path) { importInput.value = path; await importDirectory(); } } catch (error) { setStatus(error.message, true); } });
  importBar.addEventListener('submit', event => { event.preventDefault(); importDirectory(); });
  async function discoverAndImport() {
    importBar.classList.remove('hidden');
    if (!discovered && !importInput.value.trim()) {
      setWaiting(true,'正在查找 Codex 日志…');
      try {
        const result = await api('/api/statistics/directories', {});
        discovered = true;
        if (!importInput.value.trim() && result.directory) importInput.value = result.directory;
      } catch (error) {setWaiting(false); setStatus('查找失败：' + error.message, true); return; }
    }
    if (!active || ui.scope !== 'local') return;
    if (importInput.value.trim()) await importDirectory();
    else { await load(); setStatus('未找到 Codex 日志，请选择 sessions 目录。'); }
  }
  async function importDirectory() {
    const directory = importInput.value.trim(); if (!directory || importing) return;
    const mine = ++generation;
    let importedStatus='';
    importing = true; loading = true; importGo.disabled = true; importPick.disabled = true; importInput.disabled = true; refresh.disabled = true;
    host.setAttribute('aria-busy', 'true');setWaiting(true,'正在读取本地日志并整理用量…');
    try {
      const result = await api('/api/statistics/import', { directory });
      localImported = true;
      if (mine !== generation || !active) return;
      resetPaging();
      const total = result.statistics?.details?.total || 0;
      importedStatus=total ? `已读取 ${integer(result.scan?.filesRead)} 份日志，导入 ${integer(total)} 条记录${result.scan?.partial?'；部分日志未计入':''}。` : '日志中没有可确认的回合或用量记录。';
    }
    catch (error) { if (mine === generation && active) setStatus('导入失败：' + error.message, true); }
    finally {
      importing = false; importGo.disabled = false; importPick.disabled = false; importInput.disabled = false;
      if (mine === generation) { loading = false; refresh.disabled = false; host.removeAttribute('aria-busy');setWaiting(false); renderPager(); }
    }
    if(importedStatus)await load(ui.scope==='local'?importedStatus:'');
  }

  const status = el(document, 'p', 'page-status'); status.setAttribute('role', 'status');status.style.minHeight='1.5em';
  const wait=el(document,'div','stats-loading-placeholder hidden');wait.setAttribute('aria-hidden','true');for(let i=0;i<6;i++)wait.append(el(document,'div','stats-skeleton'));
  const overview = el(document, 'section', 'stats-overview');
  const kpis = el(document, 'div', 'kpi-row'); kpis.setAttribute('role', 'tablist'); kpis.setAttribute('aria-label', '图表指标');
  const chartBox = el(document, 'div', 'chart-box');
  const chartHead = el(document, 'div', 'chart-head');
  const chartTitle = el(document, 'strong', 'chart-title');
  const chartNote = el(document, 'span', 'chart-note');
  chartHead.append(chartTitle, chartNote);
  const chartHost = el(document, 'div', 'chart-host');
  chartBox.append(chartHead, chartHost);
  const trend=el(document,'div','stats-trend');
  overview.append(kpis,trend);

  const perf = el(document, 'section', 'perf-strip'); perf.setAttribute('aria-label', '性能');
  const balance=el(document,'section','subscription-balance');balance.hidden=true;
  const balanceTitle=el(document,'h2','','预估订阅总额'),balanceRows=el(document,'div','balance-windows'),balanceNote=el(document,'p','balance-note');
  balance.append(balanceTitle,balanceRows,balanceNote);
  trend.append(chartBox,balance);
  function refreshBalance(){
    if(!active||!readQuota)return;
    if(quotaRead)return quotaRead;
    const generation=++quotaGeneration;
    quotaRead=loadBalance(generation).finally(()=>{if(generation===quotaGeneration)quotaRead=null;});
    return quotaRead;
  }
  async function loadBalance(generation){
    try{
      const result=await readQuota();
      if(generation!==quotaGeneration||!active)return;
      const windows=result.windows||[];
      quotaWindows=windows;
      balanceRows.replaceChildren(...windows.map(w=>{
        const row=el(document,'div','balance-window');
        const reason=!w.usedPercent?'额度消耗尚为 0%':!w.count?'本周期没有已计量请求':w.unpriced?'有请求缺少单价':'';
        const meter=el(document,'div','balance-meter'),fill=el(document,'span');
        fill.style.width=w.usedPercent+'%';meter.append(fill);meter.setAttribute('aria-hidden','true');
        row.append(el(document,'span','balance-period',windowLabel(w.windowDurationMins)),el(document,'strong',w.estimatedTotalUsd==null?'pending':'',w.estimatedTotalUsd==null?'待估算':usd(w.estimatedTotalUsd)),
          meter,el(document,'small','',w.estimatedTotalUsd==null?reason:`已用 ${w.usedPercent}% · 已记录 ${usd(w.spentUsd)}`));
        row.title='下次额度重置 '+localTime(w.resetsAt*1000);
        return row;
      }));
      balanceNote.textContent=windows.length?'总额按本周期已记录的参考费用除以已用比例估算。'+(windows.some(w=>w.customProvider)?'含自定义提供方，仅计入订阅的请求可用于估算。':''):(result.reason||'尚无当前订阅的额度数据。');
    }catch{
      if(!active||generation!==quotaGeneration)return;
      quotaWindows=[];balanceRows.replaceChildren();balanceNote.textContent='订阅额度暂时无法读取。';
    }
    balance.hidden=false;range.updateReset();
  }

  const table = el(document, 'section', 'stats-table');
  const tabs = el(document, 'div', 'table-tabs'); tabs.setAttribute('role', 'tablist');
  const filters = el(document, 'div', 'table-filters');
  const modelFilter = el(document, 'select'); modelFilter.setAttribute('aria-label', '按模型筛选');
  const accountFilter=el(document,'select');accountFilter.setAttribute('aria-label','按登录账户筛选');
  accountFilter.addEventListener('change',()=>{ui.account=accountFilter.value;resetPaging();load();});
  modelFilter.addEventListener('change', () => { ui.model = modelFilter.value; resetPaging(); load(); });
  filters.append(icon(document, 'search', { size: 14 }), accountFilter, modelFilter);
  const tableHead = el(document, 'div', 'table-head'); tableHead.append(tabs, filters);
  const scroller = el(document, 'div', 'table-scroll');
  const pager = el(document, 'div', 'table-pager');
  const costPanel=el(document,'section','stats-popover stats-cost');
  costPanel.id='stats-cost-panel';costPanel.tabIndex=-1;
  costPanel.setAttribute('role','dialog');costPanel.setAttribute('aria-label','费用明细');
  const costPopup=mountStatPopover(null,costPanel,{boundary:header,focusOnOpen:costPanel});
  table.append(tableHead, scroller, pager,costPanel);

  const scopeNote = el(document, 'details', 'scope-note');
  const scopeSummary = el(document, 'summary', '', '数据口径');
  const scopeBody = el(document, 'div', 'scope-body');
  scopeNote.append(scopeSummary, scopeBody);

  const pricePanel=el(document,'details','scope-note pricing-settings');pricePanel.append(el(document,'summary','','参考价格设置'));
  const priceForm=el(document,'form','pricing-form');
  const field=(label,node)=>{const wrap=el(document,'label','pricing-field');wrap.append(el(document,'span','',label),node);return wrap;};
  const priceModel=el(document,'input');priceModel.placeholder='精确模型 ID';priceModel.setAttribute('aria-label','价格对应模型');
  const lookup=el(document,'button','btn','查找价格源');lookup.type='button';
  const source=el(document,'select');source.setAttribute('aria-label','参考价格源');
  const option=(label,value)=>{const node=el(document,'option','',label);node.value=value;return node;};
  source.append(option('请选择价格源',''));
  const mode=el(document,'select');mode.setAttribute('aria-label','价格模式');mode.append(option('自动匹配原厂参考价','automatic'),option('手填参考单价','manual'),option('指定其他参考源（高级）','catalog'));
  const manual=el(document,'div','pricing-manual'),rates={};
  for(const [key,label]of [['input','输入'],['output','输出'],['cacheRead','缓存读取'],['cacheWrite','缓存写入'],['reasoning','推理输出']]){const input=el(document,'input');input.type='number';input.min='0';input.step='any';input.placeholder='未知';input.setAttribute('aria-label',label+'单价');rates[key]=input;manual.append(field(label,input));}
  const savePrice=el(document,'button','btn primary','保存参考价');savePrice.type='submit';
  const priceState=el(document,'p','page-status');priceState.setAttribute('role','status');
  const updateMode=()=>{manual.hidden=mode.value!=='manual';source.hidden=mode.value!=='catalog';if(source.parentElement)source.parentElement.hidden=mode.value!=='catalog';lookup.hidden=mode.value==='automatic';};mode.addEventListener('change',updateMode);updateMode();
  priceForm.append(field('模型',priceModel),lookup,field('计价方式',mode),field('价格源 / USD 每百万 tokens',source),manual,savePrice);
  updateMode();pricePanel.append(priceForm,el(document,'p','page-sub','基础参考档按所选基础单价估算；不推断每次调用的上下文档位。空白单价保留未知。'),priceState);
  let priceLookupGeneration=0,candidates=[],candidateIdentity=null,legacyProvider=null;
  priceModel.addEventListener('input',()=>{legacyProvider=null;candidateIdentity=null;++priceLookupGeneration;lookup.disabled=false;savePrice.disabled=false;});
  async function lookupPrices(){
    const mine=++priceLookupGeneration;const model=priceModel.value.trim();lookup.disabled=true;savePrice.disabled=true;candidateIdentity=null;priceState.textContent='正在查找…';
    try{const result=await api('/api/pricing/model',{model,...(legacyProvider?{provider:legacyProvider}:{})});if(mine!==priceLookupGeneration)return;candidates=result.candidates||[];candidateIdentity=model;source.replaceChildren(option('请选择价格源',''),...candidates.map((row,index)=>option(`${row.catalogProvider} · ${row.input??'—'} / ${row.output??'—'}${row.segmented?' · 基础参考档':''}`,String(index))));
      for(const [key,input]of Object.entries(rates))input.value=result.matchedBy==='manual'?result[key]??'':'';
      if(result.matchedBy==='manual')mode.value='manual';
      else if(result.matchedBy==='explicit-alias'){mode.value='catalog';const selected=candidates.findIndex(row=>row.catalogProvider===result.catalogProvider&&row.catalogModel===result.catalogModel);source.value=selected<0?'':String(selected);}
      priceState.textContent=result.unsupportedReason||(result.catalogProvider?`当前参考：${result.catalogProvider}${result.referenceTier==='base'?' · 基础参考档':''}`:'手工参考单价');updateMode();
    }catch(error){if(mine===priceLookupGeneration)priceState.textContent=error.message;}
    finally{if(mine===priceLookupGeneration){lookup.disabled=false;savePrice.disabled=false;}}
  }
  lookup.addEventListener('click',lookupPrices);
  priceForm.addEventListener('submit',async event=>{
    event.preventDefault();if(savePrice.disabled)return;savePrice.disabled=true;
    try{const entry={mode:mode.value,model:priceModel.value.trim(),...(legacyProvider?{provider:legacyProvider}:{})};
      if(entry.mode==='catalog'){const selected=candidateIdentity===entry.model&&source.value!==''?candidates[Number(source.value)]:null;if(!selected)throw new Error('请先查找并选择价格源');Object.assign(entry,{catalogProvider:selected.catalogProvider,catalogModel:selected.catalogModel,referenceTier:selected.segmented?'base':'standard'});}
      if(entry.mode==='manual')for(const [key,input]of Object.entries(rates))entry[key]=input.value.trim()===''?null:Number(input.value);
      const result=await api('/api/pricing/configure',entry);resetPaging();await load();priceState.textContent=result.persistenceWarning||result.unsupportedReason||'已保存参考价';
    }catch(error){priceState.textContent=error.message;}finally{savePrice.disabled=false;}
  });
  function openPrice(row){pricePanel.open=true;legacyProvider=row.estimatedCost?.reference?.scope==='provider'?row.provider:null;priceModel.value=row.model||'';mode.value='automatic';updateMode();priceModel.focus();lookupPrices();}
  host.replaceChildren(header, importBar, status, pricePanel, wait, overview, perf, table, scopeNote);

  function segmented(options, value, onChange) {
    const node = el(document, 'div', 'segmented'); node.setAttribute('role', 'radiogroup');
    const buttons = options.map(([key, label]) => {
      const button = el(document, 'button', '', label); button.type = 'button'; button.dataset.value = key; button.setAttribute('role', 'radio');
      button.addEventListener('click', () => { if (importing || button.getAttribute('aria-checked') === 'true') return; set(key); onChange(key); });
      node.append(button); return button;
    });
    const set = key => { for (const button of buttons) button.setAttribute('aria-checked', String(button.dataset.value === key)); };
    set(value); return { node, set };
  }
  function setWaiting(value,label='正在读取统计…'){host.classList.toggle('stats-loading',value);wait.classList.toggle('hidden',!value||!!data);for(const section of [overview,perf,table,scopeNote])section.classList.toggle('hidden',value&&!data);if(value)setStatus(label);}
  function setStatus(text, error = false) { status.textContent = text; status.classList.toggle('error', error);status.hidden=false; }
  // A fresh query: new time anchor, first page. Paging keeps both.
  function resetPaging() { ui.cursor = null; ui.history = []; ui.anchor = null; }

  async function load(successStatus='',quiet=false) {
    if (!active || importing) return;
    const mine = ++generation; loading = true; refresh.disabled = true; host.setAttribute('aria-busy', 'true');
    const fresh=ui.anchor===null;
    renderPager();
    importBar.classList.toggle('hidden', ui.scope !== 'local');
    refresh.setAttribute('aria-label','正在更新统计');if(!quiet)setWaiting(true,data?'正在刷新，先显示已有数据…':'正在读取统计…');
    try {
      if(fresh&&ui.range==='reset'){
        await refreshBalance();
        if(mine!==generation)return;
        ui.start=latestResetStart();
        if(ui.start===null){data=null;resetPaging();throw new Error('尚无当前订阅的额度重置时间，请选择其他范围。');}
      }
      if(fresh)ui.anchor=Date.now();
      const query={...statisticsQuery(ui),detailLevel:'request'};const result = await api('/api/statistics/query', query);
      if (mine !== generation) return;
      loading = false; data = result;dataBucket=query.bucket; setStatus(successStatus); render();
    } catch (error) {
      if (mine !== generation) return;
      loading = false; setStatus('统计读取失败：' + error.message, true); render();
    } finally { if (mine === generation) { loading = false; refresh.disabled = false;refresh.setAttribute('aria-label','刷新统计'); host.removeAttribute('aria-busy');setWaiting(false); renderPager(); } }
  }

  function render() {
    const totals = data?.totals || null;
    titles.querySelector('.page-sub').textContent=data?[data.currentAccount?.email,data.currentAccount?.planType,localTime(data.generatedAt)+' 更新'].filter(Boolean).join(' · '):'';
    renderKpis(totals); renderChart(); renderPerf(totals); renderTable(); renderScope();
    importBar.classList.toggle('hidden', ui.scope !== 'local');
  }

  function kpi(key, label, value, sub, help) {
    const button = el(document, 'button', 'kpi'); button.type = 'button'; button.setAttribute('role', 'tab');
    const selectable = Object.hasOwn(METRICS, key);
    button.disabled = !selectable; button.setAttribute('aria-selected', String(ui.metric === key));
    button.append(el(document, 'span', 'kpi-label', label), el(document, 'strong', 'kpi-value', value), el(document, 'span', 'kpi-sub', sub || ''));
    if (help) button.title = help;
    if (selectable) button.addEventListener('click', () => { ui.metric = key; renderKpis(data?.totals); renderChart(); });
    return button;
  }
  function renderKpis(t) {
    if (!t) { kpis.replaceChildren(kpi('tokens', 'Tokens', UNKNOWN), kpi('turns', '回合', UNKNOWN), kpi('cost', '费用', UNKNOWN), kpi('cache', '缓存命中', UNKNOWN)); return; }
    const io = `输入 ${compact(t.inputTokens)} · 输出 ${compact(t.outputTokens)}`;
    kpis.replaceChildren(
      kpi('tokens', 'Tokens', compact(t.totalTokens), io, `总计 ${integer(t.totalTokens)} tokens · 输入 ${integer(t.inputTokens)}（含缓存）· 输出 ${integer(t.outputTokens)}`),
      kpi('turns', '回合', integer(t.turnCount), `${integer(t.requestCount)} 次已计量请求 · ${integer(t.submissionCount)} 次提交`, '每次模型请求返回用量后计入；同一回合可以有多次请求。'),
      kpi('cost', '费用', usd(t.estimatedCost?.usd), t.estimatedCost?.usd!=null&&!t.estimatedCost.complete?'部分记录小计':'USD', '按模型单价计算，展开明细可查看用量与小计'),
      kpi('cache', '缓存命中', percent(t.cacheHitRate,1), `缓存 ${compact(t.cachedInputTokens)} / 输入 ${compact(t.inputTokens)}`, '缓存输入 ÷ 输入'),
    );
  }
  function bucketLabel(iso) { const hour = dataBucket === 'hour'; return localTime(iso, { date: !hour, time: hour }); }
  function renderChart() {
    const metric = METRICS[ui.metric] || METRICS.tokens;
    const trend = Array.isArray(data?.trend) ? data.trend : [];
    chartTitle.textContent = `${metric.label} · ${dataBucket === 'hour' ? '按小时' : '按天'}`;
    chartNote.textContent = trend.length ? `${trend.length} 个有数据的时间段` : '';
    chartHost.style.minHeight='200px';chartHost.firstElementChild?.dispose?.();
    chartHost.replaceChildren(barChart(document, trend.map(row => ({ label: bucketLabel(row.start), value: metric.value(row), title: `${localTime(row.start)} · ${metric.format(metric.value(row))} · ${integer(row.turnCount)} 回合` })), { format: metric.format }));
  }
  function perfCell(label, stat, format, help) {
    const cell = el(document, 'div', 'perf-cell'); cell.title = help;
    const values = el(document, 'div', 'perf-values');
    values.append(el(document, 'strong', '', stat?.count ? format(stat.p50) : UNKNOWN), el(document, 'span', '', stat?.count ? `p95 ${format(stat.p95)}` : '无样本'));
    cell.append(el(document, 'span', 'perf-label', label), values, el(document, 'span', 'perf-n', stat?.count ? `n=${integer(stat.count)}` : ''));
    return cell;
  }
  function renderPerf(t) {
    const p = t?.performance;
    const outcome = el(document, 'div', 'perf-cell perf-outcome');
    const bar = el(document, 'div', 'outcome-bar'); bar.setAttribute('role', 'img');
    const parts = [['ok', t?.completedCount, '完成'], ['stop', t?.interruptedCount, '已停止'], ['fail', t?.failedCount, '失败']];
    const total = parts.reduce((sum, [, n]) => sum + (Number.isFinite(n) ? n : 0), 0);
    for (const [kind, n] of parts) if (n > 0) { const seg = el(document, 'span', 'seg-' + kind); seg.style.flexGrow = String(n); bar.append(seg); }
    bar.setAttribute('aria-label', parts.map(([, n, label]) => `${label} ${integer(n)}`).join('，'));
    const legend = el(document, 'div', 'outcome-legend');
    for (const [kind, n, label] of parts) { const item = el(document, 'span', 'leg-' + kind, `${label} ${integer(n)}`); legend.append(item); }
    outcome.append(el(document, 'span', 'perf-label', '回合结果'), total ? bar : el(document, 'span', 'perf-empty', '无已结束回合'), legend);
    perf.replaceChildren(
      perfCell('首次可见输出等待', p?.firstTextLatencyMs, seconds, '从回合开始到第一段可见文本；包含思考与工具时间，不是 API 首 token 延迟'),
      perfCell('回合总耗时', p?.durationMs, seconds, '原生回合时长或观测的开始到结束；包含工具与等待'),
      perfCell('回合平均输出', p?.turnOutputTokensPerSecond, value => rate(value, 'tok/s'), '已完成回合的输出 tokens ÷ 整轮耗时（含思考、工具与等待），不是纯模型生成速度'),
      outcome,
    );
  }

  const DETAIL_COLUMNS = [
    ['time', '时间', row => localTime(row.timestamp || row.completedAt || row.startedAt,{seconds:true}), row => Date.parse(row.timestamp || row.completedAt || row.startedAt || '') || 0],
    ['model', '模型', row => row.model || UNKNOWN, row => row.model || ''],
    ['account', '登录账户', row => row.account?.email || (row.account?.type==='apiKey'?'API Key':UNKNOWN), row => row.account?.label || ''],

    ['status', '记录', row => row.kind==='request'?'模型请求':row.kind==='turn'?'回合汇总':row.kind==='remainder'?'未分项用量':'用量记录', row => row.kind || ''],
    ['input', '输入', row => compact(row.tokens?.inputTokens), row => row.tokens?.inputTokens ?? -1, 'num'],
    ['cached', '缓存', row => compact(row.tokens?.cachedInputTokens), row => row.tokens?.cachedInputTokens ?? -1, 'num'],
    ['output', '输出', row => compact(row.tokens?.outputTokens), row => row.tokens?.outputTokens ?? -1, 'num'],
    ['cost', '费用', row => usd(row.estimatedCost?.usd), row => row.estimatedCost?.usd ?? -1, 'num'],
    ['first', '首次输出', row => seconds(row.performance?.firstTextLatencyMs), row => row.performance?.firstTextLatencyMs ?? -1, 'num'],
    ['duration', '耗时', row => seconds(row.performance?.durationMs), row => row.performance?.durationMs ?? -1, 'num'],
    ['speed', '回合 tok/s', row => rate(row.performance?.turnOutputTokensPerSecond, 'tok/s'), row => row.performance?.turnOutputTokensPerSecond ?? -1, 'num'],
  ];
  const GROUP_COLUMNS = [
    ['turns', '回合', row => integer(row.turnCount), row => row.turnCount ?? -1, 'num'],
    ['tokens', 'Tokens', row => compact(row.totalTokens), row => row.totalTokens ?? -1, 'num'],
    ['input', '输入', row => compact(row.inputTokens), row => row.inputTokens ?? -1, 'num'],
    ['output', '输出', row => compact(row.outputTokens), row => row.outputTokens ?? -1, 'num'],
    ['cache', '缓存命中', row => percent(row.cacheHitRate,1), row => row.cacheHitRate ?? -1, 'num'],
    ['cost', '费用', row => usd(row.estimatedCost?.usd), row => row.estimatedCost?.usd ?? -1, 'num'],
    ['success', '成功率', row => percent(row.successRate), row => row.successRate ?? -1, 'num'],
    ['p50', '耗时 p50', row => seconds(row.performance?.durationMs?.p50), row => row.performance?.durationMs?.p50 ?? -1, 'num'],
    ['tps', '回合 tok/s p50', row => rate(row.performance?.turnOutputTokensPerSecond?.p50, 'tok/s'), row => row.performance?.turnOutputTokensPerSecond?.p50 ?? -1, 'num'],
  ];
  function renderTabs() {
    const counts = { details: data?.details?.total, models: data?.models?.length, accounts:data?.accounts?.length };
    tabs.replaceChildren(...[['details', '明细'], ['models', '模型'], ['accounts','登录账户']].map(([key, label]) => {
      const tab = el(document, 'button', 'tab'); tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(ui.tab === key));
      tab.append(el(document, 'span', '', label), el(document, 'span', 'count', Number.isFinite(counts[key]) ? integer(counts[key]) : ''));
      tab.addEventListener('click', () => { ui.tab = key; ui.sort = null; renderTable(); });
      return tab;
    }));
    const option = (label, value) => { const node = el(document, 'option', '', label); node.value = value; return node; };
    const options = (select, rows, key, current, all) => {
      const names = [...new Set((rows || []).map(row => row[key]).filter(value => typeof value === 'string'))];
      select.replaceChildren(option(all, ''), ...names.map(name => option(name, name)));
      if (current && !names.includes(current)) select.append(option(current, current));
      select.value = current;
    };
    options(modelFilter, data?.models, 'model', ui.model, '全部模型');

    accountFilter.replaceChildren(option('全部账户',''),...(data?.accounts||[]).map(row=>option(row.label,row.account)));accountFilter.value=ui.account;
  }
  function showCost(button,row,detail){
    const cost=row.estimatedCost;
    const heading=el(document,'div','cost-heading');
    heading.append(el(document,'strong','','费用明细'),el(document,'span','',usd(cost?.usd)));
    const nodes=[heading];
    if(!detail){
      nodes.push(el(document,'p','',costCoverage(cost)));
    }else{
      const parts=el(document,'dl','cost-parts');
      for(const part of cost?.components||[]){
        if(part.tokens==null&&part.usd==null)continue;
        const label=el(document,'dt','',COST_PARTS[part.kind]||part.kind);
        label.append(el(document,'small','',`${compact(part.tokens)} tok × ${usd(part.pricePerMillion)} / M`));
        if(part.tokens!=null)label.title=integer(part.tokens)+' tokens';
        parts.append(label,el(document,'dd','',usd(part.usd)));
      }
      if(parts.children.length)nodes.push(parts);
      if(cost?.tokenSource==='verified-local-turn')nodes.push(el(document,'p','','已按同一回合原始日志校准用量；未与本应用观察值重复相加。'));
      if(!cost?.complete){
        const reason=!row.model?'此轮尚未记录模型，无法匹配单价。':costCompletenessReason(cost);
        nodes.push(el(document,'p','',reason));
        if(!row.model||cost?.components?.some(part=>part.tokens==null))nodes.push(el(document,'p','','可在「Codex 日志」导入这段对话的 sessions 目录，补充原始用量记录。'));
      }
      if(cost?.reference?.catalogProvider)nodes.push(el(document,'p','','价格来源：'+cost.reference.catalogProvider));
      else if(cost?.reference?.source==='manual')nodes.push(el(document,'p','','使用手填单价'));
      if(row.model){
        const configure=el(document,'button','btn small','调整单价');configure.type='button';
        configure.addEventListener('click',()=>{costPopup.close();openPrice(row);});nodes.push(configure);
      }
    }
    const restoreAction=costPanel.contains(document.activeElement)&&document.activeElement?.tagName==='BUTTON';
    costPanel.replaceChildren(...nodes);costPopup.show(button);
    if(restoreAction)costPanel.querySelector('button')?.focus({preventScroll:true});
  }
  function renderTable() {
    const openKey=costPopup.anchor?.dataset.record;
    let restoreCost=null;
    renderTabs();
    const detail = ui.tab === 'details';
    const groupKey=ui.tab==='models'?'model':'label';
    const columns = detail ? DETAIL_COLUMNS : [[groupKey,ui.tab==='models'?'模型':'登录账户',row=>row[groupKey]||'未归类',row=>row[groupKey]||''],...GROUP_COLUMNS];
    let rows = detail ? data?.details?.data || [] : data?.[ui.tab] || [];
    if (ui.sort) { const column = columns.find(c => c[0] === ui.sort.key); if (column) rows = [...rows].sort((a, b) => { const x = column[3](a), y = column[3](b); return (x > y ? 1 : x < y ? -1 : 0) * ui.sort.dir; }); }
    const tableNode = el(document, 'table', 'data-table');
    const head = el(document, 'thead'); const tr = el(document, 'tr');
    for (const [key, label, , , kind] of columns) {
      const th = el(document, 'th', kind || ''); th.scope = 'col';
      const button = el(document, 'button', 'sort', label); button.type = 'button';
      const dir = ui.sort?.key === key ? ui.sort.dir : 0;
      th.setAttribute('aria-sort', dir === 1 ? 'ascending' : dir === -1 ? 'descending' : 'none');
      button.addEventListener('click', () => { ui.sort = { key, dir: ui.sort?.key === key ? -ui.sort.dir : kind === 'num' ? -1 : 1 }; renderTable(); });
      th.append(button); tr.append(th);
    }
    head.append(tr);
    const body = el(document, 'tbody');
    for (const row of rows) {
      const line = el(document, 'tr');
      if (row.status) line.dataset.status = row.status;
      for (const [key, , text, , kind] of columns) {
        const td = el(document, 'td', [kind, key === 'model' ? 'mono' : ''].filter(Boolean).join(' '), text(row));
        const tokenKey={tokens:'totalTokens',input:'inputTokens',cached:'cachedInputTokens',output:'outputTokens'}[key];
        if(tokenKey&&Number.isFinite((row.tokens||row)[tokenKey]))td.title=integer((row.tokens||row)[tokenKey])+' tokens';
        if(key==='cost'&&(detail||row.estimatedCost&&!row.estimatedCost.complete)){
          const button=el(document,'button','cost-trigger',usd(row.estimatedCost?.usd));button.type='button';
          button.title='查看费用明细';button.setAttribute('aria-label','查看费用明细 · '+(row.estimatedCost?.usd==null?'暂无金额':button.textContent));
          button.setAttribute('aria-controls',costPanel.id);button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');
          button.dataset.record=JSON.stringify([ui.scope,ui.tab,detail?row.id:row[ui.tab==='models'?'model':'account']]);
          const show=()=>showCost(button,row,detail);
          button.addEventListener('click',()=>costPopup.anchor===button?costPopup.close(true):show());
          if(button.dataset.record===openKey)restoreCost=show;
          td.replaceChildren(button);
        }
        line.append(td);
      }
      body.append(line);
    }
    tableNode.append(head, body);
    scroller.replaceChildren(rows.length ? tableNode : el(document, 'p', 'table-empty', data ? '没有符合条件的记录' : '尚未读取'));
    if(restoreCost)restoreCost();else costPopup.close();
    renderPager();
  }
  function renderPager() {
    pager.replaceChildren();
    if (ui.tab !== 'details' || !data) return;
    const prev = el(document, 'button', 'btn', '上一页'); prev.type = 'button'; prev.disabled = !ui.history.length || loading;
    const next = el(document, 'button', 'btn', '下一页'); next.type = 'button'; next.disabled = !data.details?.nextCursor || loading;
    prev.addEventListener('click', () => { if (loading) return; ui.cursor = ui.history.pop() || null; load(); });
    next.addEventListener('click', () => { if (loading || !data.details?.nextCursor) return; ui.history.push(ui.cursor); ui.cursor = data.details.nextCursor; load(); });
    pager.append(el(document, 'span', '', `第 ${ui.history.length + 1} 页 · 共 ${integer(data.details?.total)} 条`), prev, next);
  }
  function renderScope() {
    const c = data?.coverage; const pricing = data?.pricing;
    const lines = [];
    lines.push(ui.scope === 'local' ? '导入日志：来自你选择的 Codex sessions 目录中的元数据与累计 token 差值；不包含首字延迟或流速。' : '本应用观测：只包括本窗口实际看到的回合；一个回合可能包含多次模型调用。');
    lines.push('两个范围可能重叠，界面不会相加。官方账户用量见“账户”。');
    lines.push('“首次可见输出等待”包含思考与工具时间，不是 API 首 token。“回合平均输出 tok/s”= 已完成回合输出 tokens ÷ 整轮耗时（含思考、工具与等待），不是纯模型生成速度；当前协议不提供纯推理耗时，因此纯生成速度与 TTFT 不显示。');
    lines.push('费用按模型单价与已记录的 tokens 计算，单位为美元。实际扣款以服务商账单为准。');
    if(pricing?.available&&pricing.fetchedAt)lines.push('公开价格更新时间：'+localTime(pricing.fetchedAt));
    const coverage=costCoverage(data?.totals?.estimatedCost);if(coverage)lines.push(coverage);
    if(pricing?.persistenceWarning)lines.push(pricing.persistenceWarning);if(pricing?.refreshWarning)lines.push(pricing.refreshWarning);
    if (c?.partial) lines.push('覆盖不完整：部分记录被排除或截断。');
    if(c?.unknownModelRows>0)lines.push(`${integer(c.unknownModelRows)} 条记录缺少模型名称。可从原始 Codex 日志补充。`);
    if (c?.excludedOverlappingThreads || c?.excludedAmbiguousSessions) lines.push(`Token 归属暂缓：重叠对话 ${integer(c.excludedOverlappingThreads)}，歧义会话 ${integer(c.excludedAmbiguousSessions)}；可确认的回合仍保留。`);
    if (data?.dsh && data.dsh.available === false) lines.push('DSH 子代理：' + (data.dsh.reason || '暂无可验证的用量数据'));

    if (c?.persistenceWarning) lines.push(String(c.persistenceWarning));
    if (c?.modelRecoveryError) lines.push('日志补全未完成：' + c.modelRecoveryError);
    scopeBody.replaceChildren(...lines.map(line => el(document, 'p', '', line)));
    scopeSummary.textContent = c?.partial ? '数据口径 · 部分覆盖' : '数据口径';
  }

  render();
  return {
    usageUpdated,
    refreshBalance,
    recovered() { if (active && ui.scope === 'light' && !ui.cursor && !importing) {ui.anchor=null;void refreshBalance();return load();} },
    activate() {
      active = true;
      void refreshBalance();
      syncRangeClock();
      if(!ui.cursor)ui.anchor=null;
      const initial = ui.scope === 'local' && !localImported ? discoverAndImport() : load();
      const started = generation;
      api('/api/pricing/ensure',{}).then(async info=>{
        await initial;
        // A late price refresh must not reset pagination, its frozen time range,
        // or a newer user query. Only refresh the unchanged visible query.
        if(!active||generation!==started)return;
        if(info?.refreshWarning)setStatus(info.refreshWarning);
        else if(info?.available&&info.fetchedAt!==data?.pricing?.fetchedAt)load();
      }).catch(()=>{});
    },
    deactivate() { range.close();costPopup.close();active = false;quotaGeneration++;quotaRead=null;clearTimeout(liveRefresh);liveRefresh=null;syncRangeClock();generation++; loading = false;setWaiting(false);host.removeAttribute('aria-busy'); },
    reset() { data = null;quotaGeneration++;quotaRead=null;quotaWindows=[];balance.hidden=true;balanceRows.replaceChildren();balanceNote.textContent='';range.close();range.updateReset();resetPaging();render(); },
  };
}
