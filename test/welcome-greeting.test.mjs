import test from 'node:test';
import assert from 'node:assert/strict';
import {welcomeGreeting,mountWelcomeGreeting} from '../public/ui/welcome-greeting.js';
const at=(hour,minute=0,day=14)=>new Date(2026,10,day,hour,minute);
test('welcome uses local hour at each period boundary',()=>{
 for(const [hour,period] of [[0,0],[4,0],[5,5],[10,5],[11,11],[13,11],[14,14],[17,14],[18,18],[21,18],[22,22],[23,22]])assert.equal(welcomeGreeting(at(hour)).period,period);
 assert.notEqual(welcomeGreeting(at(23,59)).key,welcomeGreeting(at(0,0,15)).key);
});
test('welcome stays stable across renders and has daily variety',()=>{
 for(let h=0;h<24;h++)assert.deepEqual(welcomeGreeting(at(h,0)),welcomeGreeting(at(h,59)));
 for(const hour of [0,5,11,14,18,22])assert.ok(new Set(Array.from({length:15},(_,i)=>welcomeGreeting(at(hour,0,i+1)).text)).size>=2);
});
test('welcome changes only at date/period boundary, resumes after hidden, and disposes',()=>{
 let time=at(10,59),timer,listener,writes=0,text='';
 const node={set textContent(value){text=value;writes++;}};
 const doc={visibilityState:'visible',addEventListener:(_n,f)=>listener=f,removeEventListener:(_n,f)=>assert.equal(f,listener)};
 const stop=mountWelcomeGreeting(node,{now:()=>time,setTimer:f=>(timer=f,1),clearTimer:()=>{},documentRef:doc});
 const original=text;timer();assert.equal(writes,1);assert.equal(text,original);
 time=at(11);timer();assert.equal(writes,2);
 time=at(18);listener();assert.equal(writes,3);stop();timer();assert.equal(writes,3);
});
