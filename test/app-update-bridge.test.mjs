import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createDesktopInstallerBridge} from '../src/desktop-app-update-bridge.mjs';
const file=path.resolve('CodexLight-Setup.exe'),sha256='a'.repeat(64);

test('native installer protocol sends only fixed request fields and accepts one matching acknowledgement',async()=>{
 let request;const bridge=createDesktopInstallerBridge({send:value=>{request=value;}});
 const operation=bridge.launch(file,{sha256});assert.deepEqual(Object.keys(request).sort(),['path','requestId','sha256','type']);assert.equal(request.type,'launchInstaller');assert.equal(request.path,file);
 assert.throws(()=>bridge.launch(file,{sha256}),/重复/);assert.equal(bridge.receive({action:'folderPicked'}),false);
 assert.throws(()=>bridge.receive({action:'installerLaunched',requestId:request.requestId,error:null,extra:true}),/Invalid/);
 assert.throws(()=>bridge.receive({action:'installerLaunched',requestId:'00000000-0000-4000-8000-000000000000',error:null}),/Invalid/);
 assert.throws(()=>bridge.receive({action:'installerLaunched',requestId:request.requestId,error:'C:\\secret\\raw exception'}),/Invalid/);
 assert.equal(bridge.receive({action:'installerLaunched',requestId:request.requestId,error:null}),true);await operation;bridge.close();
});
test('native timeout remains unknown after a late acknowledgement and never retransmits',async()=>{
 const requests=[];const bridge=createDesktopInstallerBridge({send:value=>requests.push(value),timeoutMs:15});
 await assert.rejects(bridge.launch(file,{sha256}),error=>error.outcome==='unknown');const request=requests[0];
 bridge.receive({action:'installerLaunched',requestId:request.requestId,error:null});assert.throws(()=>bridge.launch(file,{sha256}),error=>error.outcome==='unknown');assert.equal(requests.length,1);bridge.close();
});
test('known host failure is sanitized, while explicit uncertain response or pipe close stay unknown',async()=>{
 for(const [nativeError,outcome] of [['APP_UPDATE_NOT_EXECUTED','notExecuted'],['APP_UPDATE_LAUNCH_UNKNOWN','unknown']]){
  let request;const bridge=createDesktopInstallerBridge({send:value=>request=value});const operation=bridge.launch(file,{sha256});bridge.receive({action:'installerLaunched',requestId:request.requestId,error:nativeError});await assert.rejects(operation,error=>error.outcome===outcome);bridge.close();
 }
 const bridge=createDesktopInstallerBridge({send:()=>{}});const pending=bridge.launch(file,{sha256});bridge.close();await assert.rejects(pending,error=>error.outcome==='unknown');
});
test('real desktop stdio rejects an unsolicited installer acknowledgement without executing anything',async t=>{
 const child=spawn(process.execPath,['src/desktop-backend.mjs','--demo'],{stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());
 let output='';const ready=new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n'))resolve(JSON.parse(output.split('\n')[0]));});child.once('error',reject);child.once('exit',()=>reject(new Error('Backend exited before ready')));});
 child.stdin.write('{"action":"start"}\n');const started=await ready;assert.ok(started.url);
 const stopped=once(child,'exit');child.stdin.write(JSON.stringify({action:'installerLaunched',requestId:'00000000-0000-4000-8000-000000000000',error:null})+'\n');assert.equal((await stopped)[0],0);assert.equal(output.includes('"type":"launchInstaller"'),false);
});
