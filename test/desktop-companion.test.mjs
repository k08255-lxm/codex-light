import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopCompanion } from '../public/ui/desktop-companion.js';
import { mountAccountQuota } from '../public/account-quota.js';
import { createDocument } from './mini-dom.mjs';

test('desktop companion joins task and quota updates without polling, leaking content or replaying unchanged snapshots',async()=>{
  const messages=[], pet=createDesktopCompanion(message=>messages.push(message));
  const tasks=(connected,...ids)=>{
    pet.tasks(connected,new Map(ids.map(id=>[id,'任务 '+id])),new Map(),new Set());
    pet.activity({connected,running:ids.map(id=>({threadId:id,turnId:'turn-'+id,phase:'work'}))});
  };
  const document=createDocument(), host=document.createElement('div');
  const appearance={theme:'dark',reducedMotion:true};
  let fail=false;
  const quota=mountAccountQuota(host,{rpc:async()=>{
    if(fail)throw new Error('offline');
    return {rateLimits:{limitName:'private bucket',primary:{windowDurationMins:300,usedPercent:92}}};
  },onChange:pet.quota});
  tasks(true,'a','b','c');pet.pending(2,1);await quota.start();
  assert.equal(messages.length,0);
  pet.appearance('lulu',appearance,125);await Promise.resolve();
  assert.deepEqual(messages[0],{type:'desktopCompanion',character:'lulu',size:125,dark:true,reducedMotion:true,
    connected:true,running:3,agents:0,taskNames:['任务 a','任务 b','任务 c'],phase:'work',questions:2,approvals:1,quota:[{minutes:300,remaining:8}],stale:false});
  tasks(true,'a','b','c');pet.pending(2,1);await Promise.resolve();assert.equal(messages.length,1);
  fail=true;await quota.refresh();assert.equal(messages.at(-1).stale,true);
  quota.reset();pet.pending(0,0);tasks(false);await Promise.resolve();
  assert.deepEqual(messages.at(-1),{...messages[0],questions:0,approvals:0,connected:false,running:0,taskNames:[],quota:[],stale:false});
  pet.appearance('off',appearance,125);await Promise.resolve();
  assert.deepEqual(messages.at(-1),{type:'desktopCompanion',character:'off'});
  const count=messages.length;quota.stop();tasks(true,'a');await Promise.resolve();assert.equal(messages.length,count);
  pet.appearance('nailong',appearance,125);await Promise.resolve();
  assert.equal(messages.at(-1).running,1);assert.equal(messages.at(-1).character,'nailong');
});

test('companion restores background phases, prefers a live command, and drops superseded or finished turns',async()=>{
  const messages=[],pet=createDesktopCompanion(message=>messages.push(message)),turns=new Map(),terminal=new Set();
  const sync=()=>pet.tasks(true,new Map(),turns,terminal);
  const thinking={threadId:'background',turnId:'b1',name:'画角色',phase:'thinking'};
  const tool={threadId:'front',turnId:'f1',phase:'work'};
  const send=(...running)=>pet.activity({connected:true,running});
  async function expect(phase,running){
    await Promise.resolve();
    assert.equal(messages.at(-1).phase,phase);assert.equal(messages.at(-1).running,running);
    assert.doesNotMatch(JSON.stringify(messages.at(-1)),/private text|background|fileChange/);
  }
  pet.appearance('nailong',{theme:'light',reducedMotion:false},100);sync();
  send(thinking,tool);await expect('thinking',2);
  tool.phase='command';send(tool,thinking);await expect('command',2);
  tool.agents=1;send(thinking,tool);await expect('team',2);
  tool.agents=3;send(thinking,tool);await expect('team',2);
  turns.set('front','f2');sync();await expect('thinking',1);
  terminal.add('b1');sync();await expect('work',0);
  pet.tasks(false,new Map(),turns,terminal);send(tool);await expect('work',0);
});
