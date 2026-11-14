import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../desktop/LocalPathLinks.cs',import.meta.url),'utf8');
const script=source.split('internal const string ClickScript = """')[1].split('""";')[0];
test('native file click bridge requires trusted primary click and stays top-frame only',()=>{
 const sent=[];let click;class Element{closest(){return {getAttribute:()=> 'C:/space name/file.txt'};}}
 const window={chrome:{webview:{postMessage:value=>sent.push(value)}}};window.top=window;
 vm.runInNewContext(script,{window,Element,document:{addEventListener:(type,handler)=>{assert.equal(type,'click');click=handler;}}});
 const event={target:new Element(),isTrusted:false,button:0,preventDefault(){},stopImmediatePropagation(){}};
 click(event);assert.equal(sent.length,0);click({...event,isTrusted:true,button:1});assert.equal(sent.length,0);
 click({...event,isTrusted:true});assert.equal(sent.length,1);assert.equal(sent[0].type,'revealLocalPath');assert.equal(sent[0].path,'C:/space name/file.txt');
 let attached=false;vm.runInNewContext(script,{window:{top:{}},document:{addEventListener:()=>{attached=true;}}});assert.equal(attached,false);
});
test('native bridge has no backend/LAN open endpoint and always prompts',()=>{
 const host=fs.readFileSync(new URL('../desktop/MainWindow.cs',import.meta.url),'utf8');
 assert.match(host,/TrustedSource\(e.Source,origin\)&&LocalPathLinks.TrustedSource\(core.Source,origin\)/);
 const body=host.split('void RevealLocalPath(string json)')[1].split('async Task PickFolderAsync')[0];
 assert.match(body,/MessageBoxButtons.YesNo/);assert.ok(body.indexOf('MessageBoxButtons.YesNo')<body.indexOf('Process.Start'));
});
