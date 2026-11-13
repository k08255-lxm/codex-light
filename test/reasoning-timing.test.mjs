import test from 'node:test';
import assert from 'node:assert/strict';
import {reasoningTimeLabel} from '../public/reasoning-timing.js';

test('summary delivery snapshots do not invent zero seconds of thinking',()=>{
  for(const gap of [0,1,236,999])assert.equal(reasoningTimeLabel({startedAtMs:1000,completedAtMs:1000+gap},{done:true}),'');
  assert.equal(reasoningTimeLabel({durationMs:0},{done:true}),'');
  assert.equal(reasoningTimeLabel({durationMs:-1},{done:true}),'');
  assert.equal(reasoningTimeLabel({startedAtMs:2000,completedAtMs:1000},{done:true}),'');
});
test('explicit duration and meaningful live/native intervals are retained',()=>{
  assert.equal(reasoningTimeLabel({durationMs:400},{done:true}),'不足 1 秒');
  assert.equal(reasoningTimeLabel({durationMs:3200},{done:true}),'3 秒');
  assert.equal(reasoningTimeLabel({durationMs:0,startedAtMs:1000,completedAtMs:5000},{done:true}),'4 秒');
  assert.equal(reasoningTimeLabel({_startedAtMs:1000},{done:false,now:5000}),'4 秒');
  assert.equal(reasoningTimeLabel({startedAtMs:1000},{done:true}),'');
});
