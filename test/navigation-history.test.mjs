import test from 'node:test';
import assert from 'node:assert/strict';
import {createNavigationHistory} from '../public/ui/navigation-history.js';
test('page, settings section and conversation navigation supports back, forward and branch replacement',()=>{
 const h=createNavigationHistory({name:'chat',threadId:'a'});
 h.push({name:'usage'});h.push({name:'settings',section:'configuration'});h.push({name:'chat',threadId:'b'});
 assert.equal(h.move(-1).section,'configuration');assert.equal(h.move(-1).name,'usage');
 assert.equal(h.move(1).section,'configuration');h.push({name:'account'});assert.equal(h.canForward,false);
 assert.equal(h.move(-1).section,'configuration');assert.equal(h.move(-1).name,'usage');assert.equal(h.move(-1).threadId,'a');assert.equal(h.canBack,false);
});
