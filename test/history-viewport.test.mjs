import test from 'node:test';import assert from 'node:assert/strict';
import {historyViewport} from '../public/history-viewport.js';import {ItemStore} from '../public/store.js';
const rows=(start,end)=>Array.from({length:end-start},(_,i)=>({id:String(start+i),type:'agentMessage',text:'message '+(start+i),_complete:true}));
test('all logical rows remain, only viewport/overscan materialize, measured heights span continuous scroll',()=>{
 const data=rows(0,10000),heights=new Map([['0',600],['1',200]]);let view=historyViewport(data,heights,0,800);
 assert.equal(view.length,10000);assert.equal(view[0].size,600);assert.ok(view.filter(x=>x.visible).length<10);
 view=historyViewport(data,heights,1000000,800);assert.ok(view.filter(x=>x.visible).length<15);assert.equal(view[0].visible,false);
 view=historyViewport(data,heights,3200000,800);assert.equal(view.at(-1).visible,true);
});
test('older pages preserve every newer row and current live state',()=>{
 const s=new ItemStore(Infinity);rows(800,1200).forEach(x=>s.upsert(x));s.delta('1199',' live');
 s.prependHistory([...rows(400,800),{id:'1199',type:'agentMessage',text:'stale',_complete:true}]);
 s.prependHistory(rows(0,400));assert.equal(s.items.size,1200);assert.equal(s.values().at(-1).id,'1199');assert.equal(s.items.get('1199').text,'message 1199 live');assert.equal(s.items.get('1199')._complete,false);
 s.delta('1199',' next');assert.equal(s.items.get('1199').text,'message 1199 live next');
 const before=s.values();s.prependHistory(rows(0,400));assert.deepEqual(s.values(),before);
});

test('conversation preserves full primary bodies past 4Mi per field and 24Mi aggregate',()=>{
 const s=new ItemStore(Infinity,{preserveBodies:true});const body='a'.repeat(5*1024*1024)+'END';
 for(let n=0;n<6;n++)s.upsert({id:'a'+n,type:'agentMessage',text:body,_complete:true});
 s.prependHistory([{id:'old',type:'userMessage',content:[{type:'text',text:'x'.repeat(40000)+'OLDEND'}],_complete:true}]);
 for(let n=0;n<6;n++){const item=s.items.get('a'+n);assert.equal(item.text,body);assert.equal(item._omitted,undefined);assert.equal(item._released,undefined);}
 s.delta('a5',' LIVE');assert.equal(s.items.get('a5').text,body+' LIVE');assert.equal(s.items.get('old').content[0].text.length,40006);
 s.upsert({id:'cmd',type:'commandExecution',aggregatedOutput:body,_complete:true});assert.equal(s.items.get('cmd').aggregatedOutput,body);
});
