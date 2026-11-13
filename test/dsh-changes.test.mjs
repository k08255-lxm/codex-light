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
 assert.ok(second.structuredContent.events.every(event=>event.success===true&&event.taskTurn===1&&event.changes[0].diffFormat==='fragment'&&event.changes[0].lineStats.added===1&&event.changes[0].lineStats.removed===1),'applied fragments retain precise edit statistics without inventing full-file locations');
 const before=calls.length;await reader.read('thread:agent','agent',call,{status:'completed',updatedAt:'stamp'});assert.equal(calls.length,before);
});

test('edit evidence does not invent changes for failed tool results',async()=>{
 const reader=new DshChangeReader(),{call}=fixture(1);
 const result=await reader.read('thread:agent','agent',async(tool,args)=>{
  const response=await call(tool,args);if(args.event_id)response.structuredContent.events[0].data.message.isError=true;return response;
 },{status:'completed',updatedAt:'stamp'});
 assert.deepEqual(result.structuredContent.events,[]);
});

const CWD='C:\\Users\\Lee\\Documents\\ChatGPT\\codex-light';
const TARGET='C:\\Users\\Lee\\Documents\\ChatGPT\\codex-light\\test\\created.test.mjs';
const CALL_ID='call_00_NJPErZh8ynqKa0otYMXx0925';

// Mirrors the recorded DSH shape: listing events carry only summaries, while the detail
// reads return the complete tool/call arguments and tool/result metadata.
function createFixture(options={}){
 const {content='first\nsecond\n',filePath=TARGET,metaPath=TARGET,operation='create',tool='write',isError=false,args=undefined,callEvent={},resultEvent={},callId=CALL_ID}=options;
 const callDetail={type:'tool/call',event_id:11,seq:11,summary:{name:tool,callId},data:{turn:1,step:4,name:tool,arguments:args===undefined?{file_path:filePath,content}:args,callId},...callEvent};
 const resultDetail={type:'tool/result',event_id:12,seq:12,data:{turn:1,message:{toolCallId:callId,isError},meta:{operation,path:metaPath,diffs:[]}},...resultEvent};
 const listing=[{type:'tool/call',event_id:11,seq:11,summary:{name:tool,callId}},{type:'tool/result',event_id:12,seq:12}];
 const calls=[];
 const call=async(name,argsValue)=>{
  assert.equal(name,'dsh_events');calls.push(argsValue);
  if(argsValue.event_id===11)return {structuredContent:{events:[callDetail]}};
  if(argsValue.event_id===12)return {structuredContent:{events:[resultDetail]}};
  assert.equal(argsValue.agent_id,'agent');
  return {structuredContent:{events:listing.filter(row=>row.event_id>argsValue.after),next_cursor:listing.at(-1).event_id,has_more:false}};
 };
 return {call,calls};
}

async function readCreate(options={}){
 const reader=new DshChangeReader(),{call,calls}=createFixture(options);
 const result=await reader.read('thread:agent','agent',call,{status:'completed',updatedAt:'stamp',cwd:CWD});
 return {reader,calls,result,events:result.structuredContent.events};
}

test('create without DSH diffs counts the complete paired write call content',async()=>{
 const {calls,events}=await readCreate({content:'first\nsecond\n'});
 assert.equal(events.length,1);assert.equal(events[0].success,true);
 const [change]=events[0].changes;
 assert.deepEqual(change.kind,{type:'add'});
 assert.deepEqual(change.lineStats,{added:2,removed:0});
 assert.equal(change.diff,'first\nsecond\n');
 assert.equal(change.statsReason,undefined);
 assert.equal(calls.filter(row=>row.event_id===11).length,1,'the paired call is read exactly once');
});

test('create line counts handle an empty file, CRLF and a missing trailing newline',async()=>{
 const empty=await readCreate({content:''});
 assert.deepEqual(empty.events[0].changes[0].lineStats,{added:0,removed:0});
 const crlf=await readCreate({content:'one\r\ntwo\r\n'});
 assert.deepEqual(crlf.events[0].changes[0].lineStats,{added:2,removed:0});
 assert.equal(crlf.events[0].changes[0].diff,'one\r\ntwo\r\n');
 const noEofNewline=await readCreate({content:'one\r\ntwo'});
 assert.deepEqual(noEofNewline.events[0].changes[0].lineStats,{added:2,removed:0});
});

test('create paths compare resolved Windows paths case-insensitively',async()=>{
 const {events}=await readCreate({metaPath:'c:\\users\\lee\\documents\\chatgpt\\codex-light\\TEST\\CREATED.TEST.MJS'});
 assert.deepEqual(events[0].changes[0].lineStats,{added:2,removed:0});
});

test('failed writes and update operations never borrow create content',async()=>{
 const failed=await readCreate({isError:true});
 assert.deepEqual(failed.events,[]);
 assert.equal(failed.calls.filter(row=>row.event_id===11).length,0);
 const update=await readCreate({operation:'update',content:'pretend new file\n'});
 assert.equal(update.events[0].changes[0].lineStats,undefined);
 assert.equal(update.events[0].changes[0].statsReason,'missing');
 assert.equal(update.calls.filter(row=>row.event_id===11).length,0,'updates must not read the write call as old-file proof');
});

test('create path mismatches stay unknown even when the basename matches',async()=>{
 const {events}=await readCreate({filePath:'C:\\Users\\Lee\\Documents\\ChatGPT\\codex-light\\other\\created.test.mjs'});
 const [change]=events[0].changes;
 assert.equal(change.kind.type,'add');
 assert.equal(change.lineStats,undefined);
 assert.equal(change.statsReason,'missing');
});

test('missing, partial or truncated call arguments cannot produce line counts',async()=>{
 for(const options of [
  {args:{file_path:TARGET}},
  {args:'{"file_path":"C:\\\\Users\\\\Lee","content":"partial'},
  {args:null},
  {callEvent:{truncated:true}},
 ]){
  const {events}=await readCreate(options);
  assert.equal(events.length,1);
  assert.equal(events[0].changes[0].lineStats,undefined,JSON.stringify(options));
  assert.equal(events[0].changes[0].statsReason,'missing',JSON.stringify(options));
 }
});

test('repeated reads neither duplicate the create record nor reread its call',async()=>{
 const reader=new DshChangeReader(),{call,calls}=createFixture({content:'a\nb\n'});
 const options={status:'completed',updatedAt:'stamp',cwd:CWD};
 const first=await reader.read('thread:agent','agent',call,options);
 assert.equal(first.structuredContent.events.length,1);
 const before=calls.length;
 const second=await reader.read('thread:agent','agent',call,options);
 assert.equal(second.structuredContent.events.length,1);
 assert.equal(calls.length,before);
 const third=await reader.read('thread:agent','agent',call,{...options,updatedAt:'next'});
 assert.equal(third.structuredContent.events.length,1);
 assert.equal(calls.filter(row=>row.event_id===11).length,1);
});

test('malformed or nonadvancing event pages fail visibly instead of spinning',async()=>{
 const reader=new DshChangeReader();
 await assert.rejects(reader.read('thread:agent','agent',async()=>({structuredContent:{events:[],next_cursor:0,has_more:true}})),/未向前推进/);
 await assert.rejects(reader.read('thread:other','agent',async()=>({isError:true,content:[{type:'text',text:'reader denied'}]})),/reader denied/);
});
