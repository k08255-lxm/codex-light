import test from 'node:test';import assert from 'node:assert/strict';import {PRIVATE_CODEX,validatePrivateReceipt,privateCodexRoot,discoverPrivateCodex} from '../src/private-codex.mjs';import {readFile} from 'node:fs/promises';
test('private receipt is exact pinned identity, never an arbitrary executable',()=>{
 assert.equal(validatePrivateReceipt({...PRIVATE_CODEX}),true);for(const key of Object.keys(PRIVATE_CODEX)){assert.equal(validatePrivateReceipt({...PRIVATE_CODEX,[key]:'other'}),false);const copy={...PRIVATE_CODEX};delete copy[key];assert.equal(validatePrivateReceipt(copy),false);}
 assert.equal(validatePrivateReceipt({...PRIVATE_CODEX,extra:'anything'}),false);
});
test('private root is separate from user data and never CWD or network',()=>{
 assert.equal(privateCodexRoot({env:{LOCALAPPDATA:'C:\\Users\\u\\AppData\\Local'}}),'C:\\Users\\u\\AppData\\Local\\CodexLightTools\\codex');assert.throws(()=>privateCodexRoot({env:{LOCALAPPDATA:'relative'}}));assert.throws(()=>privateCodexRoot({env:{LOCALAPPDATA:'\\\\server\\share'}}));assert.equal(discoverPrivateCodex({platform:'linux'}),null);
});
test('native installer and backend lock agree',async()=>{
 const source=await readFile('desktop/velopack/cli-prerequisite/CliPrerequisite.cs','utf8');for(const value of Object.values(PRIVATE_CODEX))assert.ok(source.includes(value));assert.ok(source.includes('AllowAutoRedirect=false'));assert.ok(source.includes('FileMode.CreateNew'));
});
