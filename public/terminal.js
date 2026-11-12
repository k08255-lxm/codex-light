import {Terminal} from './vendor/xterm.mjs';
import {FitAddon} from './vendor/addon-fit.mjs';
// Host owns visual layout. api(path,body), subscribe(handler)->unsubscribe are supplied.
// No web links addon, clipboard bridge, external scripts, or automatically executed input.
export function mountTerminal({container,status,api,subscribe,cwd}){
 const terminal=new Terminal({allowProposedApi:false,allowTransparency:false,scrollback:2000,convertEol:false,fontSize:13,fontFamily:'Consolas, monospace',theme:{background:'#181818',foreground:'#e5e5e5'},disableStdin:true});
 const fit=new FitAddon();terminal.loadAddon(fit);terminal.open(container);fit.fit();
 let id=null,disposed=false,lastSequence=0,opening=false,attempted=false,terminationRequested=false,connectionGeneration=0,writeChain=Promise.resolve(),resizeTimer;
 const report=value=>{status.textContent=value;};
 const accept=params=>{if(params.processId!==id||params.sequence<=lastSequence)return;if(lastSequence&&params.sequence>lastSequence+1)report('部分输出已超出缓冲；不会重发输入');lastSequence=params.sequence;if(params.capReached)report('官方终端输出达到上限；可中断或退出');try{const bytes=Uint8Array.from(atob(params.deltaBase64),c=>c.charCodeAt(0));terminal.write(bytes);}catch{report('终端输出格式无效');}};
 const stopState=params=>{if(params.processId!==id)return;terminal.options.disableStdin=true;report(params.state==='exited'?`已退出（${params.exitCode}）`:params.error||'终端已结束');};
 const unsubscribe=subscribe(event=>{if(event.method==='bridge/terminalOutput')accept(event.params);if(event.method==='bridge/terminalState')stopState(event.params);});
 const input=terminal.onData(text=>{if(!id||terminal.options.disableStdin)return;writeChain=writeChain.then(()=>{if(terminal.options.disableStdin||disposed)return;return api('/api/terminal/write',{processId:id,text});}).catch(error=>{terminal.options.disableStdin=true;report(`输入结果未知：${error.message}；不会重发，请关闭后重新打开终端。`);});});
 const observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(disposed||!container.getClientRects().length||!container.clientWidth||!container.clientHeight)return;fit.fit();if(id&&!terminal.options.disableStdin)void api('/api/terminal/resize',{processId:id,size:{rows:terminal.rows,cols:terminal.cols}}).catch(error=>report(`调整大小失败：${error.message}`));},120);});observer.observe(container);
 async function restore(processId){
  if(disposed||typeof processId!=='string'||!processId||(id&&id!==processId))throw new Error('不能恢复不同或已销毁的终端');
  attempted=true;id=processId;terminal.options.disableStdin=true;const generation=connectionGeneration;
  const snapshot=await api('/api/terminal/snapshot',{processId:id});if(disposed||generation!==connectionGeneration)return;
  for(const chunk of snapshot.output)accept({processId:id,...chunk});
  if(snapshot.state==='running'){terminal.options.disableStdin=false;report(`终端 · ${cwd}`);terminal.focus();}else stopState(snapshot);
 }
 return {
  async open(){if(disposed||opening||id||attempted)return;attempted=true;opening=true;report('正在打开当前工作目录终端…');try{const result=await api('/api/terminal/open',{cwd,size:{rows:terminal.rows,cols:terminal.cols}});id=result.processId;if(disposed){await api('/api/terminal/terminate',{processId:id});return;}await restore(id);}catch(error){report(`终端未就绪：${error.message}；不会自动重试`);throw error;}finally{opening=false;}},
  restore,
  connectionLost(){connectionGeneration++;terminal.options.disableStdin=true;report('连接中断；已停用输入，不会重发命令');},
  async interrupt(){if(id&&!terminal.options.disableStdin)await api('/api/terminal/write',{processId:id,text:'\u0003'});},
  async close(){terminal.options.disableStdin=true;if(id&&!terminationRequested){terminationRequested=true;await api('/api/terminal/terminate',{processId:id});}},
  dispose(){disposed=true;clearTimeout(resizeTimer);observer.disconnect();input.dispose();unsubscribe?.();terminal.dispose();if(id&&!terminationRequested){terminationRequested=true;void api('/api/terminal/terminate',{processId:id}).catch(()=>{});}},
 };
}
