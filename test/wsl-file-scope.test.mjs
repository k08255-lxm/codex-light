import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import test from 'node:test';import assert from 'node:assert/strict';
import {WslFileScope} from '../src/wsl-file-scope.mjs';
import {ArtifactPreviewService} from '../src/artifacts.mjs';
const scope=new WslFileScope('Ubuntu');
test('selected WSL path mapping preserves case and canonicalizes only host aliases',()=>{
 assert.equal(scope.host('/home/lee/A.png'),String.raw`\\wsl.localhost\Ubuntu\home\lee\A.png`);
 assert.equal(scope.linux(String.raw`\\WSL$\Ubuntu\home\lee\A.png`),'/home/lee/A.png');
 assert.notEqual(scope.host('/home/lee/A.png'),scope.host('/home/lee/a.png'));
 assert.equal(scope.resolve('/home/lee','images/a.png'),scope.host('/home/lee/images/a.png'));
 assert.equal(scope.inside('/home/lee','/home/Lee/a.png'),false);
});
test('WSL path conversion rejects traversal, other shares, alternate distro, devices and controls',()=>{
 for(const value of ['/home/../etc/a.png','/home/./a.png','//host/share','/home/a:ads','/home/a\0.png','/home/a\\b','C:\\a.png',String.raw`\\wsl.localhost\Debian\a.png`,String.raw`\\server\share\a.png`,String.raw`\\?\C:\a.png`,String.raw`\\wsl.localhost\Ubuntu\..\Debian\a.png`])assert.throws(()=>scope.host(value),e=>e.code==='WSL_PATH_REFUSED');
 for(const distro of ['../Ubuntu','Ubuntu\\x','Ubuntu.',' Ubuntu',''])assert.throws(()=>new WslFileScope(distro));
});
test('WSL artifacts keep distinct exact references and reject outside workspace before filesystem read',async t=>{
 const service=new ArtifactPreviewService({wslDistribution:'Ubuntu'});t.after(()=>service.close());
 service.bindThread({id:'t1',cwd:scope.host('/home/lee/project')});
 service.observe('t1',{type:'userMessage',content:[{type:'localImage',path:scope.host('/home/lee/A.png')},{type:'localImage',path:scope.host('/home/lee/a.png')},{type:'localImage',path:String.raw`\\wsl.localhost\Debian\home\lee\a.png`}]});
 assert.equal(service.references.get('t1').size,2);
 await assert.rejects(service.preview({threadId:'t1',path:'/etc/unknown.png'}),e=>e.code==='ARTIFACT_SCOPE_DENIED');
 await assert.rejects(service.preview({threadId:'t1',path:'../outside.png'}),e=>e.code==='WSL_PATH_REFUSED');
 await assert.rejects(service.preview({threadId:'t1',path:String.raw`\\wsl.localhost\Debian\a.png`}),e=>e.code==='WSL_PATH_REFUSED');
});

test('WSL legacy inline image roundtrip uses Linux label and selected UNC rollout without copying image',async t=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'wsl-inline-fixture-')),actual=path.join(tmp,'rollout-t1.jsonl');t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=','base64');
 await fs.writeFile(actual,[{type:'session_meta',payload:{id:'t1'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<image name=[Image #1] path="/home/lee/old/A.png">'},{type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')}]}}].map(JSON.stringify).join('\n')+'\n');
 const roots=[scope.host('/home/lee/.codex/sessions')],rollout=scope.host('/home/lee/.codex/sessions/rollout-t1.jsonl');
 const lstat=fs.lstat.bind(fs),realpath=fs.realpath.bind(fs),open=fs.open.bind(fs);
 t.mock.method(fs,'lstat',async p=>{
  if(p===rollout)return lstat(actual);
  if(String(p).startsWith(scope.root))return lstat(tmp);
  return lstat(p);
 });
 t.mock.method(fs,'realpath',async p=>String(p).startsWith(scope.root)?p:realpath(p));
 t.mock.method(fs,'open',async(p,...args)=>open(p===rollout?actual:p,...args));
 const a=new ArtifactPreviewService({wslDistribution:'Ubuntu',rolloutRoots:roots});t.after(()=>a.close());a.bindThread({id:'t1',cwd:scope.host('/home/lee/project'),path:rollout});a.observe('t1',{type:'userMessage',content:[{type:'localImage',path:scope.host('/home/lee/old/A.png')}]});
 assert.deepEqual((await a.preview({threadId:'t1',path:scope.host('/home/lee/old/A.png')})).bytes,png);
 await assert.rejects(a.preview({threadId:'t1',path:scope.host('/home/lee/old/a.png')}),e=>e.code==='ARTIFACT_SCOPE_DENIED');
});
