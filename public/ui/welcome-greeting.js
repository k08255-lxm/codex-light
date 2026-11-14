// Local time only. A date/period has a stable choice, not a render-time random one.
const periods = [
  {start:0, lines:['夜深了，从一个小问题开始。','安静的时段，留给清晰的想法。','这个想法，先写下来吧。']},
  {start:5, lines:['早上好，今天从哪里开始？','新的一天，先做一件重要的事。','早安，把想法变成第一步。']},
  {start:11, lines:['中午好，接下来想做什么？','把一个想法，往前推进一点。','午间片刻，理清下一步。']},
  {start:14, lines:['下午好，来解决一个问题。','给今天的想法一个落点。','下午的计划，从这里接着写。']},
  {start:18, lines:['晚上好，继续还是换个新想法？','把今天没展开的想法展开。','今晚，想把什么做得更好？']},
  {start:22, lines:['夜深了，按自己的节奏来。','还有个想法？先记在这里。','今天的最后一步，也可以很小。']},
];
export function welcomeGreeting(date=new Date()) {
  const hour=date.getHours();
  const period=[...periods].reverse().find(p=>hour>=p.start)||periods[0];
  const key=`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${period.start}`;
  let hash=0;for(const c of key)hash=(Math.imul(hash,31)+c.charCodeAt(0))>>>0;
  return {key,text:period.lines[hash%period.lines.length],period:period.start};
}
export function mountWelcomeGreeting(node,{now=()=>new Date(),setTimer=setTimeout,clearTimer=clearTimeout,documentRef=document}={}) {
  let timer,stopped=false,lastKey;
  function refresh(){
    if(stopped)return;clearTimer(timer);
    const date=now(),greeting=welcomeGreeting(date);
    if(greeting.key!==lastKey){node.textContent=greeting.text;lastKey=greeting.key;}
    // Reconcile time-zone/clock changes without re-rendering or animating the heading.
    timer=setTimer(refresh,60000-date.getSeconds()*1000-date.getMilliseconds());
  }
  function visible(){if(documentRef.visibilityState==='visible')refresh();}
  documentRef.addEventListener('visibilitychange',visible);refresh();
  return ()=>{stopped=true;clearTimer(timer);documentRef.removeEventListener('visibilitychange',visible);};
}
