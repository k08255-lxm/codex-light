// Coalesce concurrent recovery scans, but never memoize a finished scan forever.
export function createStatisticsRecovery({now=Date.now,intervalMs=30000}={}){
 let pending=null,lastStarted=null;
 return {run(task){if(pending)return pending;const current=now();if(lastStarted!==null&&current-lastStarted<intervalMs)return Promise.resolve(false);lastStarted=current;const work=Promise.resolve().then(task);const tracked=work.finally(()=>{if(pending===tracked)pending=null;});pending=tracked;return tracked;}};
}
