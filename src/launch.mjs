import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireInstance} from './instance.mjs';
import {requestReopen} from './reopen.mjs';
import {nativeCodex} from './runtime-path.mjs';
import {launchNative} from './native-launch.mjs';
const browserMode=process.argv.slice(2).includes('--browser');
const args=process.argv.slice(2).filter(argument=>argument!=='--browser');

if(process.platform==='win32'&&!browserMode){
 try{await launchNative({args});console.log('Codex Light 原生桌面应用已启动。');}
 catch(error){console.error(error.message);process.exitCode=1;}
}else{
console.log('浏览器开发模式：浏览器窗口与后台服务独立运行，关闭浏览器窗口不会停止后台。');

let instance;try{instance=await acquireInstance({demo:args.includes('--demo')});}catch(e){console.error(e.message);process.exit(1);}
if(instance.active){
 try{const url=await requestReopen(instance.record);openBrowser(url);console.log('已重新打开现有 Codex Light 后台实例，没有创建新任务。');process.exitCode=0;}
 catch{console.error('已有后台实例，未启动第二个服务。安全重开不可用，请恢复原浏览器窗口；不会重启或中断旧任务。');process.exitCode=1;}
} else {

const command=args.includes('--codex')?[]:['--codex',args.includes('--demo')?'demo-unused':nativeCodex()];
const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url)),...args,...command],{detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
let launched=false;
const timeout=setTimeout(()=>{console.error('GUI 启动超时；请运行 npm run serve 查看本地错误。');child.kill();process.exitCode=1;},15000);
child.on('error',e=>{instance.release().catch(()=>{});clearTimeout(timeout);console.error('无法启动：'+e.message);process.exitCode=1;});
child.on('exit',code=>{if(!launched){instance.release().catch(()=>{});clearTimeout(timeout);console.error(`GUI 启动失败 (${code})`);process.exitCode=1;}});
child.once('message',async({url,serverInstance,reopenEndpoint})=>{
 try{const parsed=new URL(url);if(parsed.hostname!=='127.0.0.1'||parsed.protocol!=='http:')throw new Error('本地服务返回了无效地址');await instance.publish({pid:child.pid,port:Number(parsed.port),serverInstance,reopenEndpoint});}catch(e){console.error(e.message);child.kill();await instance.release();return;}
 launched=true;clearTimeout(timeout);
 openBrowser(url);
 console.log('Codex Light 已启动。关闭窗口后后台仍保留；在界面设置中选择“关闭本地服务”可停止。');
 child.disconnect();child.unref();
});

}
}
function openBrowser(url){
 let browser,flags;
 if(process.platform==='win32'){
  const candidates=[process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean).map(base=>path.join(base,'Microsoft','Edge','Application','msedge.exe'));
  browser=candidates.find(existsSync);flags=[`--app=${url}`];
  if(!browser){browser='rundll32.exe';flags=['url.dll,FileProtocolHandler',url];}
 }else if(process.platform==='darwin'){browser='open';flags=[url];}
 else{browser='xdg-open';flags=[url];}
 const ui=spawn(browser,flags,{detached:true,windowsHide:true,stdio:'ignore',shell:false});
 ui.on('error',()=>console.log('请在浏览器打开：'+url));ui.unref();

}
