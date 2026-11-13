import test from 'node:test';
import assert from 'node:assert/strict';
import {DshChangeReader} from '../src/dsh-changes.mjs';

function fixture(count){
 const events=Array.from({length:count},(_,index)=>[
  {type:'tool/call',event_id:index*2+1,summary:{name:'Edit',callId:`edit-${index}`}},
  {type:'tool/result',event_id:index*2+2},
 ]).flat();const calls=[];
 const call=async(tool,args)=>{
  assert.equal(tool,'dsh_events');assert.equal(args.agent_id,'agent');calls.push(args);
  if(args.event_id!==undefined){
   const index=args.event_id/2-1;
   return {structuredContent:{events:[{type:'tool/result',event_id:args.event_id,data:{turn:1,message:{toolCallId:`edit-${index}`,isError:false},meta:{operation:'update',diffs:[{path:`/workspace/file-${index}.js`,oldText:'old fragment',newText:'new fragment'}]}}}]}};
  }
  return {structuredContent:{events:events.filter(row=>row.event_id>args.after),next_cursor:events.at(-1)?.event_id||0,has_more:false}};
 };
 return {call,calls};
}

test('edit evidence advances across the 20-detail cap and caches completed task reads',async()=>{
 const reader=new DshChangeReader(),{call,calls}=fixture(21);
 const first=await reader.read('thread:agent','agent',call,{status:'completed',updatedAt:'stamp'});
 assert.equal(first.structuredContent.events.length,20);assert.equal(first.structuredContent.has_more,true);
 assert.equal(calls.filter(row=>row.event_id!==undefined).length,20);
 const second=await reader.read('thread:agent','agent',call,{status:'completed',updatedAt:'stamp'});
 assert.equal(second.structuredContent.events.length,21);assert.equal(second.structuredContent.has_more,false);
 assert.equal(second.structuredContent.events[20].changes[0].path,'/workspace/file-20.js');
 assert.ok(second.structuredContent.events.every(event=>event.success===true&&event.taskTurn===1&&!Object.hasOwn(event.changes[0],'diff')),'replacement fragments are not fabricated net diffs');
 const before=calls.length;await reader.read('thread:agent','agent',call,{status:'completed',updatedAt:'stamp'});assert.equal(calls.length,before);
});

test('edit evidence does not invent changes for failed tool results',async()=>{
 const reader=new DshChangeReader(),{call}=fixture(1);
 const result=await reader.read('thread:agent','agent',async(tool,args)=>{
  const response=await call(tool,args);if(args.event_id)response.structuredContent.events[0].data.message.isError=true;return response;
 },{status:'completed',updatedAt:'stamp'});
 assert.deepEqual(result.structuredContent.events,[]);
});

test('malformed or nonadvancing event pages fail visibly instead of spinning',async()=>{
 const reader=new DshChangeReader();
 await assert.rejects(reader.read('thread:agent','agent',async()=>({structuredContent:{events:[],next_cursor:0,has_more:true}})),/未向前推进/);
 await assert.rejects(reader.read('thread:other','agent',async()=>({isError:true,content:[{type:'text',text:'reader denied'}]})),/reader denied/);
});
