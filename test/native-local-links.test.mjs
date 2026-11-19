import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../desktop/LocalPathLinks.cs',import.meta.url),'utf8');
const script=source.split('internal const string ClickScript = """')[1].split('""";')[0];
test('native file click bridge requires trusted primary click and stays top-frame only',()=>{
 const sent=[];let click;class Element{constructor(path='C:/space name/file.txt',image=false){this.path=path;this.image=image;}closest(){return this;}getAttribute(){return this.path;}hasAttribute(){return this.image;}}
 const window={chrome:{webview:{postMessage:value=>sent.push(value)}}};window.top=window;
 vm.runInNewContext(script,{window,Element,document:{addEventListener:(type,handler)=>{assert.equal(type,'click');click=handler;}}});
 const event={target:new Element(),isTrusted:false,button:0,preventDefault(){},stopImmediatePropagation(){}};
 click(event);assert.equal(sent.length,0);click({...event,isTrusted:true,button:1});assert.equal(sent.length,0);
 click({...event,isTrusted:true});assert.equal(sent.length,1);assert.equal(sent[0].type,'revealLocalPath');assert.equal(sent[0].path,'C:/space name/file.txt');
 const webOnly={...event,isTrusted:true,preventDefault(){assert.fail('web preview was intercepted');}};
 click({...webOnly,target:new Element('/C:/项目/截图 一.PNG',true)});
 click({...webOnly,target:new Element('child-relative.pdf')});
 assert.equal(sent.length,1);
 let attached=false;vm.runInNewContext(script,{window:{top:{}},document:{addEventListener:()=>{attached=true;}}});assert.equal(attached,false);
});
test('native bridge has no backend/LAN open endpoint and always prompts',()=>{
 const host=fs.readFileSync(new URL('../desktop/MainWindow.cs',import.meta.url),'utf8');
 assert.match(host,/TrustedSource\(e.Source,origin\)&&LocalPathLinks.TrustedSource\(core.Source,origin\)/);
 const body=host.split('void RevealLocalPath(string json)')[1].split('async Task PickFolderAsync')[0];
 const executable=body.slice(body.indexOf('IsLocalExecutable'),body.indexOf('var prompt='));
 assert.match(executable,/DefaultButton=cancel/);assert.ok(executable.indexOf('TaskDialog.ShowDialog')<executable.indexOf('Process.Start'));
 const documents=body.slice(body.indexOf('var prompt='));
 assert.ok(documents.indexOf('MessageBoxButtons.YesNo')<documents.indexOf('Process.Start'));
});
