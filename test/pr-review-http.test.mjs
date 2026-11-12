import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {createServer} from '../src/server.mjs';
class Mock extends EventEmitter{
 constructor(){super();this.connected=false;this.requests=new Map();this.calls=[];}
 async start(){this.connected=true;return {};}
 async close(){this.connected=false;}
 async call(method,params){this.calls.push({method,params});throw new Error('unexpected RPC '+method);}
}
function fakeService(){
 const calls=[];
 return {calls,
  async status(){calls.push({route:'status',params:undefined});return {ok:true,available:true,authenticated:true,login:'reader',host:'github.com',notice:'read only'};},
  async list(params){calls.push({route:'list',params});return {ok:true,login:'reader',filter:params.filter??'created',state:params.state??'open',page:params.page??1,items:[],hasMore:false};},
  async detail(params){calls.push({route:'detail',params});return {ok:true,target:{url:params.url},pullRequest:{number:12,title:'fixture'}};},
  async section(params){calls.push({route:'section',params});return {ok:true,items:[],hasMore:false,kind:params.kind};}
 };
}
async function fixture(t,{demo=false,service=fakeService()}={}){
 const app=await createServer({client:new Mock(),demo,prReviewService:service});await app.started;t.after(()=>app.close());return {app,service};
}
const post=(app,url,data,extra={})=>fetch(app.origin+url,{method:'POST',headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json',...extra},body:JSON.stringify(data)});
test('PR HTTP routes keep token, origin and POST gates',async t=>{
 const {app,service}=await fixture(t);
 assert.equal((await fetch(app.origin+'/api/pr/status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal((await post(app,'/api/pr/status',{},{Origin:'https://evil.example'})).status,403);
 assert.equal((await fetch(app.origin+'/api/pr/status',{headers:{Authorization:`Bearer ${app.token}`}})).status,405);
 assert.equal(service.calls.length,0);
});
test('status accepts an empty whitelist object only',async t=>{
 const {app,service}=await fixture(t);
 let response=await post(app,'/api/pr/status',{});assert.equal(response.status,200);
 assert.equal((await response.json()).login,'reader');
 assert.deepEqual(service.calls,[{route:'status',params:undefined}]);
 response=await post(app,'/api/pr/status',{confirmed:true});assert.equal(response.status,400);assert.match((await response.json()).error,/不支持参数 confirmed/);
 response=await post(app,'/api/pr/status',null);assert.equal(response.status,400);
 response=await post(app,'/api/pr/status',[]);assert.equal(response.status,400);
 assert.equal(service.calls.length,1);
});
test('list forwards only whitelisted filters and page, keeping pagination exact',async t=>{
 const {app,service}=await fixture(t);
 const full={filter:'review-requested',state:'closed',page:2,repository:'owner/repo'};
 let response=await post(app,'/api/pr/list',full);assert.equal(response.status,200);
 assert.deepEqual(service.calls.at(-1),{route:'list',params:full});
 response=await post(app,'/api/pr/list',{page:3});assert.equal(response.status,200);
 assert.deepEqual(service.calls.at(-1),{route:'list',params:{page:3}});
 response=await post(app,'/api/pr/list',{filter:'created',query:'is:pr'});assert.equal(response.status,400);assert.match((await response.json()).error,/不支持参数 query/);
 assert.equal(service.calls.length,2);
});
test('detail and section require a URL and reject unknown fields',async t=>{
 const {app,service}=await fixture(t);const url='https://github.com/owner/repo/pull/12';
 let response=await post(app,'/api/pr/detail',{url});assert.equal(response.status,200);assert.deepEqual(service.calls.at(-1),{route:'detail',params:{url}});
 response=await post(app,'/api/pr/detail',{});assert.equal(response.status,400);assert.match((await response.json()).error,/PR 链接参数无效/);
 response=await post(app,'/api/pr/detail',{url,body:'raw'});assert.equal(response.status,400);
 response=await post(app,'/api/pr/section',{url,kind:'review-comments',page:2});assert.equal(response.status,200);
 assert.deepEqual(service.calls.at(-1),{route:'section',params:{url,kind:'review-comments',page:2}});
 response=await post(app,'/api/pr/section',{url,kind:'files'});assert.equal(response.status,200);
 assert.deepEqual(service.calls.at(-1),{route:'section',params:{url,kind:'files'}});
 response=await post(app,'/api/pr/section',{url,kind:'files',extra:true});assert.equal(response.status,400);
 response=await post(app,'/api/pr/section',{url});assert.equal(response.status,400);
 assert.equal(service.calls.length,3);
});
test('demo mode refuses every PR route before any GitHub service call',async t=>{
 const {app,service}=await fixture(t,{demo:true});
 for(const [route,body]of [['status',{}],['list',{page:1}],['detail',{url:'https://github.com/o/r/pull/1'}],['section',{url:'https://github.com/o/r/pull/1',kind:'files'}]]){
  const response=await post(app,'/api/pr/'+route,body);assert.equal(response.status,400,route);assert.match((await response.json()).error,/演示模式不读取真实 GitHub 数据/);
 }
 assert.equal(service.calls.length,0);
});
test('upstream GitHub action failures stay explicit HTTP 200 results',async t=>{
 const service=fakeService();service.status=async()=>({ok:false,code:'GH_AUTH_REQUIRED',message:'请运行 gh auth login --hostname github.com'});
 const {app}=await fixture(t,{service});
 const response=await post(app,'/api/pr/status',{});assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{ok:false,code:'GH_AUTH_REQUIRED',message:'请运行 gh auth login --hostname github.com'});
});
test('unknown PR action is rejected without side effects',async t=>{
 const {app,service}=await fixture(t);
 const response=await post(app,'/api/pr/merge',{url:'https://github.com/o/r/pull/1'});assert.equal(response.status,400);assert.match((await response.json()).error,/未知 PR 操作/);
 assert.equal(service.calls.length,0);assert.equal(app.operations.entries.size,0);
});
test('PR panel and icon assets are served from the static whitelist',async t=>{
 const {app}=await fixture(t);
 const panel=await fetch(app.origin+'/pr-review-panel.js');assert.equal(panel.status,200);
 assert.match(panel.headers.get('content-type'),/^text\/javascript/);
 const source=await panel.text();assert.match(source,/export function mountPrReviewPanel/);assert.match(source,/from '\.\/icons\.js'/);
 assert.equal((await fetch(app.origin+'/icons.js')).status,200);
 assert.equal((await fetch(app.origin+'/pr-review-panel.mjs')).status,404);
});
