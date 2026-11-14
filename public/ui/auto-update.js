// Check only: never download, install, invoke a model, or interrupt a task.
export function startUpdateChecks({check,notify,setTimer=setTimeout,clearTimer=clearTimeout,interval=6*60*60*1000}){
 let stopped=false,busy=false,timer=null;const notified=new Set();
 async function tick(){
  if(stopped||busy)return;busy=true;
  try{const result=await check();if(!stopped&&result.latest?.available&&!notified.has(result.latest.version)){notified.add(result.latest.version);notify(result.latest.version);}}catch{/* Manual About check exposes actionable errors; startup stays unobtrusive. */}
  finally{busy=false;if(!stopped)timer=setTimer(tick,interval);}
 }
 timer=setTimer(tick,3000);
 return ()=>{stopped=true;clearTimer(timer);};
}
