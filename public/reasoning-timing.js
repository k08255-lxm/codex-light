// History often stamps a delivered reasoning summary's start/end at the same instant.
// Those delivery timestamps do not measure model thinking time.
export function reasoningTimeLabel(item, {done,now=Date.now()}={}) {
  if(done&&Number.isFinite(item.durationMs)&&item.durationMs>0)
    return item.durationMs<1000?'不足 1 秒':`${Math.floor(item.durationMs/1000)} 秒`;
  const start=item._startedAtMs??item.startedAtMs;
  const end=done?(item._completedAtMs??item.completedAtMs):now;
  if(!Number.isFinite(start)||!Number.isFinite(end)||end-start<1000)return '';
  return `${Math.floor((end-start)/1000)} 秒`;
}
