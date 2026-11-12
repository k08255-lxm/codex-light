import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from '../src/server.mjs';
async function fixture(t,options){const app=await createServer({demo:true,...options});await app.started;t.after(()=>app.close());return app;}
const post=(app,body,headers={})=>fetch(app.origin+'/api/desktop/theme',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
test('native theme is an authenticated desktop-only route',async t=>{
 const a=await fixture(t,{desktop:true,onDesktopTheme:()=>assert.fail('rejected requests must not reach the host')});
 assert.equal((await post(a,{theme:'light'},{Authorization:''})).status,401);
 assert.equal((await post(a,{theme:'dark'},{Origin:'https://evil.example'})).status,403);
 const b=await fixture(t,{onDesktopTheme:()=>assert.fail('browser mode has no native host')});
 assert.equal((await post(b,{theme:'light'})).status,409);
});
test('native theme forwards only the fixed theme/visual-style enum, keeping the legacy single-argument callback',async t=>{
 const calls=[];const a=await fixture(t,{desktop:true,onDesktopTheme:(...args)=>calls.push(args)});
 for(const value of [{},{theme:'system'},{theme:1},{theme:'light',script:'x'},{theme:'dark',visualStyle:'unknown'},{theme:'dark',visualStyle:'#ff0000'},[],null])assert.equal((await post(a,value)).status,400,JSON.stringify(value));
 assert.deepEqual(calls,[]);
 assert.deepEqual(await (await post(a,{theme:'dark'})).json(),{theme:'dark'});
 assert.deepEqual(await (await post(a,{theme:'light',visualStyle:'claude'})).json(),{theme:'light',visualStyle:'claude'});
 assert.equal((await post(a,{theme:'dark',visualStyle:'codex'})).status,200);
 assert.deepEqual(calls,[['dark'],['light','claude'],['dark','codex']]);
});
