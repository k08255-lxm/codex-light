// One scheduler per desktop backend. Only detection is automatic.
export function startUpdateChecks({check,notify=()=>{},onStatus=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,
 interval=6*60*60*1000,retry=60*1000,maxRetry=60*60*1000,reconnectDelay=15*1000,now=Date.now}){
 let stopped=false,busy=false,timer=null,failures=0,lastAttempt=-Infinity;const notified=new Set();
 function schedule(wait){if(timer!==null)clearTimer(timer);timer=setTimer(tick,wait);}
 async function tick(){
  if(stopped||busy)return;busy=true;lastAttempt=now();
  try{
   const result=await check();failures=0;
   if(!stopped)onStatus(result);
   if(!stopped&&result.latest?.available&&!notified.has(result.latest.version)){notified.add(result.latest.version);notify(result.latest.version);}
  }catch{failures++;}
  finally{busy=false;if(!stopped)schedule(failures?Math.min(maxRetry,retry*2**Math.min(failures-1,16)):interval);}
 }
 schedule(3000);
 function stop(){stopped=true;if(timer!==null)clearTimer(timer);}
 stop.reconnect=()=>{if(!stopped&&!busy&&failures)schedule(Math.max(0,lastAttempt+reconnectDelay-now()));};
 return stop;
}
