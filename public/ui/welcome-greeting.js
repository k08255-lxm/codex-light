// Local time only. A date/period has a stable choice, not a render-time random one.
// A quiet greeting, not a productivity prompt. No assumed mood or personal history.
const periods = [
  {start:0, lines:["夜深了，很高兴见到你。", "晚上好，这里不着急。", "一个小想法，也值得认真对待。", "有了新点子？写在这里就好。", "不必一下想清楚所有细节。", "今晚，给灵感留个位置。", "想试点不一样的，也可以。", "夜深了，按自己的节奏就好。"]},
  {start:5, lines:["早安，很高兴见到你。", "早上好，今天想做点什么？", "新的一天，有什么好点子？", "早安，愿今天顺顺利利。", "一个念头，也可以是好的开始。", "早上好，想法不必很完整。", "嗨，早安。", "今天想试试什么新东西？"]},
  {start:11, lines:["午安，很高兴见到你。", "中午好，今天还顺利吗？", "一个小改动，也值得用心。", "有个想法？不妨从这里试试。", "午安，愿今天有些小惊喜。", "代码之外的想法，也欢迎。", "中午好，按自己的节奏就好。", "想做的东西，有模样了吗？"]},
  {start:14, lines:["下午好，很高兴见到你。", "有什么想做出来的小东西？", "换个角度，也许会有新发现。", "下午好，今天有新点子吗？", "一个草稿就够了，我们从那儿开始。", "愿这个下午多一点灵感。", "嗨，下午好。", "有想试的办法，就一起看看。"]},
  {start:18, lines:["晚上好，今天过得怎么样？", "很高兴在今晚见到你。", "今晚，有什么想做的小东西？", "好点子不分大小。", "晚上好，愿你有个舒心的夜晚。", "想把哪个想法变成真的？", "有个没想透的点子，也可以。", "嗨，晚上好。"]},
  {start:22, lines:["夜深了，不必赶进度。", "晚上好，很高兴见到你。", "想到什么，可以先留在这里。", "今晚的灵感，有地方落笔了。", "一个小尝试，也挺好。", "还没成形的想法，也欢迎。", "夜深了，愿你今晚顺心。", "先写一点，剩下的以后再说。"]},
];
export function welcomeGreeting(date=new Date()) {
  const hour=date.getHours();
  const period=[...periods].reverse().find(p=>hour>=p.start)||periods[0];
  const key=`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${period.start}`;
  // Local calendar days, not elapsed 24-hour blocks: DST must not skip a greeting.
  // Each period cycles through all eight choices before repeating.
  const day=Math.floor(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())/86400000);
  const index=((day+periods.indexOf(period)*3)%period.lines.length+period.lines.length)%period.lines.length;
  return {key,text:period.lines[index],period:period.start};
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
