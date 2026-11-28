import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopCompanion } from '../public/ui/desktop-companion.js';
import { mountAccountQuota } from '../public/account-quota.js';
import { createDocument } from './mini-dom.mjs';

test('desktop companion joins task and quota updates without polling, leaking content or replaying unchanged snapshots',async()=>{
  const messages=[], pet=createDesktopCompanion(message=>messages.push(message));
  const document=createDocument(), host=document.createElement('div');
  const appearance={theme:'dark',reducedMotion:true};
  let fail=false;
  const quota=mountAccountQuota(host,{rpc:async()=>{
    if(fail)throw new Error('offline');
    return {rateLimits:{limitName:'private bucket',primary:{windowDurationMins:300,usedPercent:92}}};
  },onChange:pet.quota});
  pet.tasks(true,3);pet.pending(2,1);await quota.start();
  assert.equal(messages.length,0);
  pet.appearance('lulu',appearance);await Promise.resolve();
  assert.deepEqual(messages[0],{type:'desktopCompanion',character:'lulu',dark:true,reducedMotion:true,
    connected:true,running:3,questions:2,approvals:1,quota:[{minutes:300,remaining:8}],stale:false});
  pet.tasks(true,3);pet.pending(2,1);await Promise.resolve();assert.equal(messages.length,1);
  fail=true;await quota.refresh();assert.equal(messages.at(-1).stale,true);
  quota.reset();pet.pending(0,0);pet.tasks(false,0);await Promise.resolve();
  assert.deepEqual(messages.at(-1),{...messages[0],questions:0,approvals:0,connected:false,running:0,quota:[],stale:false});
  pet.appearance('off',appearance);await Promise.resolve();
  assert.deepEqual(messages.at(-1),{type:'desktopCompanion',character:'off'});
  const count=messages.length;quota.stop();pet.tasks(true,1);await Promise.resolve();assert.equal(messages.length,count);
  pet.appearance('nailong',appearance);await Promise.resolve();
  assert.equal(messages.at(-1).running,1);assert.equal(messages.at(-1).character,'nailong');
});
