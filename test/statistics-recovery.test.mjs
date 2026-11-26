import test from 'node:test';import assert from 'node:assert/strict';import {createStatisticsRecovery} from '../src/statistics-recovery.mjs';
import {StatisticsService} from '../src/statistics.mjs';
test('native child creation and settings supply live model identity without guessing from the parent',()=>{
 const stats=new StatisticsService({});
 stats.observe({method:'thread/started',params:{thread:{id:'parent',model:'parent-model'}}});
 const creation={method:'item/completed',params:{threadId:'parent',item:{type:'subAgentActivity',kind:'started',agentThreadId:'child',model:'resolved'}}};
 stats.observe(creation);
 stats.observe({method:'thread/started',params:{thread:{id:'child',model:null,modelProvider:'route'}}});
 const start=turnId=>stats.observe({method:'turn/started',params:{threadId:'child',turn:{id:turnId}}});
 start('first');
 stats.observe({method:'thread/settings/updated',params:{threadId:'child',threadSettings:{model:'next',modelProvider:'next-route'}}});
 stats.observe(creation);start('second');
 assert.deepEqual([...stats.rows.values()].map(r=>[r.model,r.provider]),[['resolved','route'],['next','next-route']]);
});
test('successful recovery releases in-flight promise and rescans later incomplete turns after TTL',async()=>{let time=0,calls=0,release;const gate=createStatisticsRecovery({now:()=>time});const first=gate.run(()=>{calls++;return new Promise(r=>release=r)});assert.equal(gate.run(()=>calls++),first);await Promise.resolve();release();await first;await gate.run(()=>calls++);assert.equal(calls,1);time=30001;await gate.run(()=>calls++);assert.equal(calls,2);time=60002;await gate.run(()=>calls++);assert.equal(calls,3);});
test('failed recovery releases pending and is retried after throttle instead of permanently cached',async()=>{let time=0,calls=0;const gate=createStatisticsRecovery({now:()=>time});await assert.rejects(gate.run(()=>{calls++;throw Error('temporary')}));await gate.run(()=>calls++);assert.equal(calls,1);time=30001;await gate.run(()=>calls++);assert.equal(calls,2);});
