import path from 'node:path';import os from 'node:os';import test from 'node:test';import assert from 'node:assert/strict';import {validateRpc,validateResponse} from '../src/security.mjs';
test('limits exposed RPC and validates explicit session permission choices',()=>{
 for(const m of ['command/exec','account/login/start','config/value/write','thread/archive'])assert.throws(()=>validateRpc(m,{}));
 assert.doesNotThrow(()=>validateRpc('turn/start',{threadId:'x',cwd:path.resolve(os.tmpdir()),input:[{type:'text',text:'hi'}],approvalPolicy:'never'}));
 assert.doesNotThrow(()=>validateRpc('thread/start',{cwd:path.resolve(os.tmpdir()),approvalPolicy:'never',sandbox:'danger-full-access'}));
 assert.throws(()=>validateRpc('thread/start',{cwd:path.resolve(os.tmpdir()),approvalPolicy:'invalid',sandbox:'danger-full-access'}));
 assert.doesNotThrow(()=>validateRpc('thread/start',{cwd:path.resolve(os.tmpdir()),approvalPolicy:'on-request',sandbox:'workspace-write'}));
});
test('requires explicit absolute cwd and bounded content',()=>{
 for(const cwd of [undefined,'relative','/tmp\0x'])assert.throws(()=>validateRpc('turn/start',{threadId:'x',cwd,input:[{type:'text',text:'hi'}]}));
 assert.throws(()=>validateRpc('turn/start',{threadId:'x',cwd:path.resolve(os.tmpdir()),input:[{type:'text',text:'x'.repeat(100001)}]}));
 assert.throws(()=>validateRpc('thread/list',{limit:10000}));
 assert.doesNotThrow(()=>validateRpc('thread/list',{limit:30,sortKey:'updated_at'}));
});
test('no blanket or persistent approvals',()=>{
 const r={method:'item/commandExecution/requestApproval',params:{availableDecisions:['accept','decline']}};
 assert.deepEqual(validateResponse(r,{decision:'accept'}),{decision:'accept'});
 for(const decision of ['acceptForSession',{acceptWithExecpolicyAmendment:{}}])assert.throws(()=>validateResponse(r,{decision}));
 assert.throws(()=>validateResponse(r,{decision:'cancel'}));
 assert.throws(()=>validateResponse({method:'unknown'},{decision:'accept'}));
 assert.throws(()=>validateResponse({method:'item/permissions/requestApproval'},{permissions:{network:{enabled:true}},scope:'turn'}));
 assert.doesNotThrow(()=>validateResponse({method:'item/permissions/requestApproval'},{permissions:{},scope:'turn'}));
});
test('MCP authorization not auto accepted',()=>{
 assert.throws(()=>validateResponse({method:'mcpServer/elicitation/request'},{action:'accept',content:{yes:true}}));
 assert.doesNotThrow(()=>validateResponse({method:'mcpServer/elicitation/request'},{action:'decline',content:null}));
});
test('only requested user questions accepted',()=>{
 const r={method:'item/tool/requestUserInput',params:{questions:[{id:'q'}]}};
 assert.doesNotThrow(()=>validateResponse(r,{answers:{q:{answers:['yes']}}}));
 assert.throws(()=>validateResponse(r,{answers:{unasked:{answers:['yes']}}}));
});
test('Windows cwd must include a drive or full UNC share, not drive-relative root',async()=>{
 const {isAbsoluteWorkingDirectory:isAbsolute}=await import('../src/security.mjs');
 for(const value of ['C:\\project','C:/project','\\\\server\\share','\\\\server\\share\\project'])assert.equal(isAbsolute(value,'win32'),true,value);
 for(const value of ['C:project','\\project','/project','\\\\server','','C:\\a\0b'])assert.equal(isAbsolute(value,'win32'),false,value);
});
test('malformed approval payloads and incomplete user input fail closed',()=>{
 assert.throws(()=>validateResponse({method:'item/permissions/requestApproval'},{scope:'turn',permissions:[]}));
 const question={method:'item/tool/requestUserInput',params:{questions:[{id:'a'},{id:'b'}]}};
 for(const answers of [{},{a:{answers:['x']}},{a:{answers:['x']},b:{answers:[1]}}])assert.throws(()=>validateResponse(question,{answers}));
 assert.doesNotThrow(()=>validateResponse(question,{answers:{a:{answers:[]},b:{answers:['  ']}}}));
 assert.throws(()=>validateRpc('turn/interrupt',{threadId:'a'}));
});
test('metadata operations retain explicit scope and account reads cannot mutate login',()=>{
 assert.doesNotThrow(()=>validateRpc('thread/name/set',{threadId:'t',name:'new title'}));assert.throws(()=>validateRpc('thread/name/set',{threadId:'t',name:''}));
 assert.doesNotThrow(()=>validateRpc('thread/fork',{threadId:'t',excludeTurns:true}));assert.throws(()=>validateRpc('thread/fork',{threadId:'t',sandbox:'danger-full-access'}));
 assert.doesNotThrow(()=>validateRpc('thread/list',{archived:true}));assert.throws(()=>validateRpc('thread/list',{archived:'false'}));
 assert.doesNotThrow(()=>validateRpc('account/read',{refreshToken:false}));assert.throws(()=>validateRpc('account/read',{refreshToken:true}));
 assert.throws(()=>validateRpc('account/logout',{}));
});
test('review feature is explicit local uncommitted inline only',()=>{
 assert.doesNotThrow(()=>validateRpc('review/start',{threadId:'t',target:{type:'uncommittedChanges'},delivery:'inline'}));
 assert.throws(()=>validateRpc('review/start',{threadId:'t',target:{type:'custom',instructions:'do anything'},delivery:'inline'}));
 assert.throws(()=>validateRpc('review/start',{threadId:'t',target:{type:'uncommittedChanges'},delivery:'detached'}));
});
test('permission grants must be exact requested subset with explicit turn or session scope',()=>{
 const req={method:'item/permissions/requestApproval',params:{threadId:'thread',turnId:'turn',permissions:{network:{enabled:true},fileSystem:{read:['/work/a'],write:['/work/b']}}}};
 assert.doesNotThrow(()=>validateResponse(req,{scope:'turn',permissions:{fileSystem:{read:['/work/a']}}}));
 for(const permissions of [{network:{enabled:true,extra:true}},{fileSystem:{read:['/etc']}},{fileSystem:{write:['/work/a']}},{fileSystem:{read:['/work/a','/work/a']}},{fileSystem:{entries:[]}}])assert.throws(()=>validateResponse(req,{scope:'turn',permissions}));
 assert.doesNotThrow(()=>validateResponse(req,{scope:'session',permissions:{network:{enabled:true}}}));
 assert.throws(()=>validateResponse({...req,params:{permissions:req.params.permissions}},{scope:'session',permissions:{network:{enabled:true}}}));
 assert.throws(()=>validateResponse(req,{scope:'always',permissions:{network:{enabled:true}}}));
 assert.throws(()=>validateResponse({method:req.method,params:{permissions:{fileSystem:{entries:[]}}}},{scope:'turn',permissions:{network:{enabled:true}}}));
});
test('MCP forms validate original schema server-side and refusals cannot send content',()=>{
 const req={method:'mcpServer/elicitation/request',params:{mode:'form',requestedSchema:{type:'object',properties:{age:{type:'integer',minimum:18},choice:{type:'string',enum:['a','b']}},required:['age']}}};
 assert.deepEqual(validateResponse(req,{action:'accept',content:{age:20},_meta:null}),{action:'accept',content:{age:20},_meta:null});
 for(const content of [{age:17},{age:'20'},{age:20,extra:true},{age:20,choice:'c'},{}])assert.throws(()=>validateResponse(req,{action:'accept',content}));
 for(const result of [{action:'decline',content:{age:20}},{action:'cancel',content:null,_meta:{token:'x'}},{action:'accept',content:{age:20},extra:true}])assert.throws(()=>validateResponse(req,result));
 assert.throws(()=>validateResponse({...req,params:{...req.params,mode:'url'}},{action:'accept',content:{age:20}}));
 assert.throws(()=>validateResponse({...req,params:{mode:'form',requestedSchema:{type:'object',properties:{password:{type:'string'}}}}},{action:'accept',content:{password:'x'}}));
});
test('plugin discovery and usage are strictly read only',()=>{
 assert.doesNotThrow(()=>validateRpc('plugin/list',{forceRefetch:false,marketplaceKinds:['local'],cwds:[process.cwd()]}));
 assert.doesNotThrow(()=>validateRpc('plugin/read',{pluginName:'p',remoteMarketplaceName:'official'}));
 for(const params of [{forceRefetch:true},{forceRefetch:false,cwds:['relative']},{forceRefetch:false,marketplaceKinds:['remote']},{forceRefetch:false,install:true}])assert.throws(()=>validateRpc('plugin/list',params));
 for(const params of [{pluginName:'p'},{pluginName:'p',marketplacePath:process.cwd(),remoteMarketplaceName:'r'},{pluginName:'p',marketplacePath:'relative'},{pluginName:'p',remoteMarketplaceName:'r',install:true}])assert.throws(()=>validateRpc('plugin/read',params));
 assert.doesNotThrow(()=>validateRpc('account/usage/read',{}));assert.doesNotThrow(()=>validateRpc('account/usage/read',{threadId:'t'}));
 for(const params of [{threadId:3},{threadId:''},{refreshToken:true}])assert.throws(()=>validateRpc('account/usage/read',params));
 assert.throws(()=>validateRpc('command/exec',{command:['echo','no']}));assert.throws(()=>validateRpc('plugin/install',{}));
});
