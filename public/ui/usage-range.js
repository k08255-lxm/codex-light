// Date range behavior follows CC Switch v4.0.30 (MIT).
import {el} from './format.js';
import {icon} from '../icons.js';
import {mountStatPopover} from './stat-popover.js';

const presets=new Map([['today','当天'],['24h','近 24 小时'],['7d','近 7 天'],['14d','近 14 天'],['30d','近 30 天'],['all','全部']]);
const dayMs=86400000;
const pad=n=>String(n).padStart(2,'0');
const dateText=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const timeText=d=>pad(d.getHours())+':'+pad(d.getMinutes());
const storageKey='codecang.usage.range';
export function initialRange(storage){
  try{const key=storage?.getItem(storageKey);if(presets.has(key))return key;}catch{/* Storage can be disabled. */}
  return 'today';
}
export function usageBounds(selection,now){
  const end=selection.range==='custom'&&!selection.liveEnd?selection.end:now;
  const day=new Date(now);
  let start;
  switch(selection.range){
    case 'custom': start=selection.start;break;
    case 'all': start=null;break;
    case '24h': start=now-dayMs;break;
    default:{
      const count=({'7d':7,'14d':14,'30d':30})[selection.range]||1;
      start=new Date(day.getFullYear(),day.getMonth(),day.getDate()-count+1).getTime();
    }
  }
  const hourly=selection.range==='today'||selection.range==='24h'||selection.range==='custom'&&end-start<=dayMs;
  return {start,end,bucket:hourly?'hour':'day'};
}

export function mountUsageRange(document,selection,onApply){
  const make=(tag,cls,text)=>el(document,tag,cls,text);
  function button(text,cls='btn small'){
    const node=make('button',cls,text);node.type='button';return node;
  }
  const trigger=button(),label=make('span'),panel=make('section','usage-range-panel');
  panel.id='usage-range-panel';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','统计时间范围');
  trigger.append(icon(document,'calendar',{size:16}),label,icon(document,'down',{size:14}));
  trigger.setAttribute('aria-controls',panel.id);trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-haspopup','dialog');
  const shortcuts=make('div','usage-range-presets');
  const layout=make('div','usage-range-layout'),fields=make('div','usage-range-fields');
  const calendar=make('div','usage-calendar'),nav=make('div','usage-calendar-nav');
  const previous=button('‹'),monthLabel=button(),next=button('›');
  previous.setAttribute('aria-label','上个月');next.setAttribute('aria-label','下个月');monthLabel.title='回到本月';
  nav.append(previous,monthLabel,next);
  const weekdays=make('div','usage-calendar-week'),days=make('div','usage-calendar-days');
  for(const day of '日一二三四五六')weekdays.append(make('span','',day));
  calendar.append(nav,weekdays,days);
  let month,activeField,clock=null;
  const entries={};
  function selectField(key){
    activeField=key;
    for(const [name,field] of Object.entries(entries))field.box.classList.toggle('selected',name===key);
  }
  function showMonth(date){month=new Date(date.getFullYear(),date.getMonth(),1);drawCalendar();}
  function drawCalendar(){
    monthLabel.textContent=month.getFullYear()+'年 '+(month.getMonth()+1)+'月';
    const start=entries.start.date.value,end=entries.end.date.value,today=dateText(new Date());
    for(let i=0;i<42;i++){
      const day=new Date(month.getFullYear(),month.getMonth(),1-month.getDay()+i);
      const stamp=dateText(day),cell=days.children[i];
      cell.textContent=day.getDate();cell.dataset.date=stamp;cell.setAttribute('aria-label',stamp);
      cell.setAttribute('aria-pressed',String(stamp===start||stamp===end));
      cell.classList.toggle('outside',day.getMonth()!==month.getMonth());
      cell.classList.toggle('in-range',stamp>start&&stamp<end);
      if(stamp===today)cell.setAttribute('aria-current','date');else cell.removeAttribute('aria-current');
    }
  }
  for(const [key,title] of [['start','开始时间'],['end','结束时间']]){
    const box=make('fieldset','usage-range-field'),date=make('input'),time=make('input');
    date.type='date';time.type='time';time.step='60';date.required=true;time.required=true;
    date.setAttribute('aria-label',title+'日期');time.setAttribute('aria-label',title+'时刻');
    box.append(make('legend','',title),date,time);entries[key]={box,date,time};fields.append(box);
    box.addEventListener('focusin',()=>selectField(key));
    date.addEventListener('input',()=>{error.textContent='';if(date.value)showMonth(new Date(date.value+'T00:00'));});
    time.addEventListener('input',()=>{error.textContent='';});
  }
  function write(key,date){
    entries[key].date.value=dateText(date);entries[key].time.value=timeText(date);
  }
  function read(key){const f=entries[key];return new Date(f.date.value+'T'+f.time.value).getTime();}
  const liveLabel=make('label','usage-range-live'),live=make('input');live.type='checkbox';
  liveLabel.append(live,document.createTextNode('结束时间跟随当前时刻'));
  function syncClock(){
    clearInterval(clock);clock=null;
    entries.end.box.disabled=live.checked;
    if(live.checked){selectField('start');write('end',new Date());clock=setInterval(()=>write('end',new Date()),1000);}
  }
  live.addEventListener('change',()=>{syncClock();drawCalendar();error.textContent='';});
  const error=make('div','usage-range-error');error.setAttribute('role','alert');
  const actions=make('div','usage-range-actions'),cancel=button('取消'),apply=button('确定','btn primary small');
  actions.append(cancel,apply);fields.append(liveLabel,error,actions);
  for(let i=0;i<42;i++)days.append(button('','usage-calendar-day'));
  days.addEventListener('click',e=>{
    const value=e.target.closest('button')?.dataset.date;if(!value)return;
    error.textContent='';
    if(activeField==='start'||live.checked){
      entries.start.date.value=value;
      if(!live.checked){if(read('start')>read('end'))write('end',new Date(read('start')));selectField('end');}
    }else{
      const proposed=new Date(value+'T'+entries.end.time.value).getTime();
      if(proposed<read('start'))entries.start.date.value=value;else entries.end.date.value=value;
    }
    showMonth(new Date(value+'T00:00'));
  });
  previous.addEventListener('click',()=>showMonth(new Date(month.getFullYear(),month.getMonth()-1,1)));
  next.addEventListener('click',()=>showMonth(new Date(month.getFullYear(),month.getMonth()+1,1)));
  monthLabel.addEventListener('click',()=>showMonth(new Date()));
  layout.append(fields,calendar);panel.append(shortcuts,layout);
  const popup=mountStatPopover(trigger,panel,{onOpen(){
    const draft=usageBounds(selection,Date.now());
    write('start',new Date(draft.start??draft.end-30*dayMs));write('end',new Date(draft.end));
    live.checked=selection.range==='custom'&&selection.liveEnd;error.textContent='';
    selectField('start');syncClock();showMonth(new Date(read('start')));
    const current=shortcuts.querySelector('[aria-pressed="true"]')||entries.start.date;
    current.focus({preventScroll:true});
  },onClose(){clearInterval(clock);clock=null;}});
  function set(value){
    selection=value;
    const stamp=ms=>new Date(ms).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
    label.textContent=presets.get(value.range)??(stamp(value.start)+' → '+(value.liveEnd?'现在':stamp(value.end)));
    trigger.title='统计时间范围 · '+label.textContent;
    for(const node of shortcuts.children)node.setAttribute('aria-pressed',String(node.dataset.range===value.range));
  }
  function commit(value){
    set(value);popup.close(true);
    if(value.range!=='custom'){try{document.defaultView?.localStorage?.setItem(storageKey,value.range);}catch{/* Storage can be disabled. */}}
    onApply(value);
  }
  for(const [key,title] of presets){const node=button(title);node.dataset.range=key;node.addEventListener('click',()=>commit({range:key}));shortcuts.append(node);}
  cancel.addEventListener('click',()=>popup.close(true));
  apply.addEventListener('click',()=>{
    const start=read('start'),end=live.checked?Date.now():read('end');
    if(!Number.isFinite(start)||!Number.isFinite(end)){error.textContent='请填写完整的日期和时间。';return;}
    if(start>end){error.textContent='开始时间不能晚于结束时间。';return;}
    commit({range:'custom',start,end,liveEnd:live.checked});
  });
  set(selection);return {trigger,panel,close:popup.close};
}
