import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
test('resizing an open application menu dismisses it and returns focus',()=>{
 const handler=source.match(/window\.addEventListener\('resize',\s*\(\)\s*=>\s*\{([^\n]+)\}\);/);
 assert.ok(handler,'menu resize handler is registered');
 const calls=[];
 const run=new Function('activeMenu','closeWindowMenu','focusAfterWindowMenu',handler[1]);
 run('app',()=>calls.push('close'),()=>calls.push('focus'));
 assert.deepEqual(calls,['close','focus']);
 calls.length=0;run(null,()=>calls.push('close'),()=>calls.push('focus'));
 assert.deepEqual(calls,[],'ordinary resize never steals focus when menu is closed');
});
