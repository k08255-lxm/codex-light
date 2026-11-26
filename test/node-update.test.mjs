import test from 'node:test';
import assert from 'node:assert/strict';
import {NodeUpdateCheck} from '../src/node-update.mjs';

const schedule={v20:{end:'2026-04-30',lts:'2023-10-24'},v24:{end:'2028-04-30',lts:'2025-10-28'},v26:{end:'2029-04-30',lts:'2026-10-28'}};
function fixture(current,lines){
 const calls=[];
 const check=new NodeUpdateCheck({current,now:()=>new Date('2026-11-26'),fetchFn:async url=>{
  calls.push(url);
  return new Response(url.endsWith('schedule.json')?JSON.stringify(schedule):lines);
 }});
 return {check,calls};
}
const msi=version=>'a'.repeat(64)+'  node-v'+version+'-x64.msi\r\n';
test('an existing supported Node stays on its major, with overlapping checks coalesced',async()=>{
 const {check,calls}=fixture('24.22.2',msi('24.22.3'));const [a,b]=await Promise.all([check.check(),check.check()]);
 assert.deepEqual(a,b);assert.equal(a.available,true);assert.equal(a.latest,'24.22.3');
 assert.equal(calls.length,2);assert.match(calls[1],/latest-v24\.x/);
 assert.equal((await fixture('24.22.3',msi('24.22.3')).check.check()).available,false);
});
test('EOL selects supported LTS and malformed official data cannot advertise an update',async()=>{
 const {check,calls}=fixture('20.0.0',msi('26.13.1'));assert.equal((await check.check()).endOfLife,true);assert.match(calls[1],/latest-v26\.x/);
 for(const manifest of [msi('26.0.0'),msi('24.22.3')+msi('24.22.4'),'unavailable']){
  const {check}=fixture('24.22.2',manifest);await assert.rejects(check.check());assert.ok(check.status.error);assert.equal(check.status.available,undefined);
 }
});
