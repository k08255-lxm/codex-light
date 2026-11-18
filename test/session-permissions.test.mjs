import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SessionPermissions} from '../src/session-permissions.mjs';

test('persisted permission choices are scoped to their thread, identified account and Codex runtime',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'codex-permissions-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new SessionPermissions(root,'native');
 const {scope}=await store.access('account-a','original');
 await store.access('account-a','original',{scope,mode:'request'});
 assert.equal((await new SessionPermissions(root,'native').access('account-a','original')).mode,'request');
 assert.equal((await store.access('account-a','other')).mode,null);
 assert.equal((await store.access('account-b','original')).mode,null);
 assert.equal((await new SessionPermissions(root,'wsl').access('account-a','original')).mode,null);
 await assert.rejects(store.access('account-b','original',{scope,mode:'full'}),/账户已变化/);
 await assert.rejects(store.access('account-a','original',{scope,mode:'invalid'}));
 const unknown=await store.access(null,'original');
 await store.access(null,'original',{scope:unknown.scope,mode:'full'});
 assert.equal((await store.access(null,'original')).mode,'full');
 store.resetAnonymous();assert.equal((await store.access(null,'original')).mode,null);
 await assert.rejects(store.access(null,'original',{scope:unknown.scope,mode:'full'}));
});
