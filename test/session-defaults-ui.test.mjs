import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionDefaultsBridge,sanitizeSessionDefaults} from '../public/submissions.js';
import {activeModelId,configuredReasoningView,defaultModelView,reasoningParameter,restoredReasoning,switchedReasoning} from '../public/reasoning.js';
const INSTANCE='a'.repeat(32),OTHER='b'.repeat(32);
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const model={model:'gpt-5-codex',displayName:'GPT-5 Codex',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}],defaultReasoningEffort:'medium'};
const six={model:'gpt-6-astra',displayName:'GPT-6 Astra',supportedReasoningEfforts:['minimal','low','medium','high','xhigh','max'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'medium'};
const catalog=[model,six,{model:'gpt-5-mini',displayName:'GPT-5 Mini'}];
test('configured defaults are read once per instance and cwd, shown, never sent as overrides',async()=>{
 const calls=[];const bridge=new SessionDefaultsBridge(async body=>{calls.push(body);return {model:'gpt-5-codex',modelProvider:'openai',reasoningEffort:'high',apiKey:'SECRET',cwd:'/private'};});
 bridge.sync({connected:true,serverInstance:INSTANCE,cwd:'/project'});assert.deepEqual(calls,[]);await flush();
 assert.deepEqual(calls,[{cwd:'/project'}]);
 assert.deepEqual(bridge.snapshot().value,{model:'gpt-5-codex',modelProvider:'openai',reasoningEffort:'high'});
 assert.ok(!JSON.stringify(bridge.snapshot()).includes('SECRET'));
 assert.deepEqual(sanitizeSessionDefaults({model:' gpt-5-codex ',modelProvider:null,reasoningEffort:3,extra:'x'}),{model:'gpt-5-codex',modelProvider:null,reasoningEffort:null});
 const selection=restoredReasoning(null),view=configuredReasoningView(model,selection,bridge.snapshot().value);
 assert.equal(view.source,'config');assert.equal(view.effective,'high');assert.equal(view.index,2);assert.equal(view.configSupport,'supported');
 assert.equal(reasoningParameter(selection),undefined);
 bridge.sync({connected:true,serverInstance:INSTANCE,cwd:'/project'});await flush();assert.equal(calls.length,1);
});
test('stale responses for an old cwd, instance or disconnected session are discarded',async()=>{
 const pending=[];const bridge=new SessionDefaultsBridge(body=>new Promise(resolve=>pending.push({body,resolve})));
 bridge.sync({connected:true,serverInstance:INSTANCE,cwd:'/one'});
 bridge.sync({connected:true,serverInstance:INSTANCE,cwd:'/two'});
 await flush();
 assert.deepEqual(pending.map(entry=>entry.body),[{cwd:'/one'},{cwd:'/two'}]);
 pending[0].resolve({model:'old',reasoningEffort:'low'});await flush();assert.equal(bridge.snapshot().value,null);
 pending[1].resolve({model:'new'});await flush();assert.equal(bridge.snapshot().value.model,'new');
 const second=[];const instanceBridge=new SessionDefaultsBridge(body=>new Promise(resolve=>second.push({body,resolve})));
 instanceBridge.sync({connected:true,serverInstance:INSTANCE,cwd:'/p'});
 instanceBridge.sync({connected:true,serverInstance:OTHER,cwd:'/p'});
 await flush();
 second[0].resolve({model:'old-instance'});await flush();assert.equal(instanceBridge.snapshot().value,null);
 instanceBridge.sync({connected:false,serverInstance:OTHER,cwd:'/p'});second[1].resolve({model:'late'});await flush();
 assert.equal(instanceBridge.snapshot().value,null);assert.equal(instanceBridge.retry(),false);
});
test('user explicit model and restored thread effort win over configured defaults',()=>{
 const defaults={model:'gpt-5-codex',reasoningEffort:'medium'};
 const explicit={...restoredReasoning('low'),override:'high'},explicitView=configuredReasoningView(model,explicit,defaults);
 assert.equal(explicitView.effective,'high');assert.equal(explicitView.source,'override');assert.equal(explicitView.index,2);
 assert.equal(reasoningParameter(explicit),'high');
 const inherited=restoredReasoning('custom-future'),inheritedView=configuredReasoningView(model,inherited,defaults);
 assert.equal(inheritedView.effective,'custom-future');assert.equal(inheritedView.source,'inherited');assert.equal(inheritedView.index,-1);
 assert.equal(reasoningParameter(inherited),undefined);
});
test('unsupported or missing configured effort stays unknown instead of using the catalog default',()=>{
 const unsupported=configuredReasoningView(model,restoredReasoning(null),{model:'gpt-5-codex',reasoningEffort:'ultra'});
 assert.equal(unsupported.effective,null);assert.equal(unsupported.index,-1);assert.equal(unsupported.configured,'ultra');assert.equal(unsupported.configUnsupported,true);assert.equal(unsupported.configSupport,'unsupported');assert.equal(unsupported.source,'unknown');
 assert.equal(reasoningParameter(restoredReasoning(null)),undefined);
 const missing=configuredReasoningView(model,restoredReasoning(null),null);
 assert.equal(missing.effective,null);assert.equal(missing.source,'unknown');assert.equal(missing.configured,null);
});
test('default model presentation identifies configured, outside-catalog and selected models',()=>{
 assert.deepEqual(defaultModelView(catalog,'',{model:'gpt-5-codex'}),{id:'gpt-5-codex',name:'GPT-5 Codex',displayName:'GPT-5 Codex',source:'config',outsideCatalog:false});
 assert.equal(defaultModelView(catalog,'',{model:'future-model'}).displayName,'future-model（目录外）');
 assert.equal(defaultModelView(catalog,'gpt-5-mini',{model:'gpt-5-codex'}).source,'selected');
 assert.equal(defaultModelView(catalog,'gpt-5-mini',{model:'gpt-5-codex'}).displayName,'GPT-5 Mini');
 assert.equal(defaultModelView(catalog,'',null).displayName,null);assert.equal(defaultModelView(catalog,'',null).source,'unknown');
});
test('a failed read surfaces an error and only an explicit retry issues another request',async()=>{
 const bodies=[];let attempts=0;const bridge=new SessionDefaultsBridge(async body=>{bodies.push(body);attempts++;if(attempts===1)throw new Error('配置读取失败');return {model:'gpt-5-codex',reasoningEffort:'low'};});
 bridge.sync({connected:true,serverInstance:INSTANCE,cwd:'/project'});await flush();
 assert.equal(bridge.snapshot().error,'配置读取失败');assert.equal(bridge.snapshot().value,null);
 await flush();assert.equal(attempts,1);
 assert.equal(bridge.retry(),true);await flush();
 assert.equal(attempts,2);assert.deepEqual(bodies,[{cwd:'/project'},{cwd:'/project'}]);assert.equal(bridge.snapshot().value.model,'gpt-5-codex');
});
test('a failing render callback is not silently swallowed',()=>{
 const bridge=new SessionDefaultsBridge(async()=>({model:'gpt-5-codex'}),{onChange(){throw new Error('ui failed');}});
 assert.throws(()=>bridge.sync({connected:true,serverInstance:INSTANCE,cwd:'/project'}),/ui failed/);
});
test('empty default selection resolves the configured model so six stops are usable and xhigh is display-only',()=>{
 const defaults={model:'gpt-6-astra',reasoningEffort:'xhigh'},activeId=activeModelId('',defaults);
 assert.equal(activeId,'gpt-6-astra');
 const view=configuredReasoningView(six,restoredReasoning(null),defaults,activeId);
 assert.equal(view.choices.length,6);assert.equal(view.effective,'xhigh');assert.equal(view.index,4);assert.equal(view.source,'config');assert.equal(view.configUnsupported,false);
 assert.equal(reasoningParameter(restoredReasoning(null)),undefined);
 const moved={...restoredReasoning(null),override:view.choices[1]};
 assert.equal(reasoningParameter(moved),'low');
});
test('switching back to the empty default clears the explicit effort override',()=>{
 const defaults={model:'gpt-6-astra',reasoningEffort:'xhigh'},selection={...restoredReasoning(null),override:'high'};
 assert.equal(reasoningParameter(switchedReasoning(six,selection,{configuredModel:defaults.model,selectedModel:''})),undefined);
 assert.equal(reasoningParameter(switchedReasoning(six,selection,{configuredModel:defaults.model,selectedModel:defaults.model})),'high');
});
test('another explicit model never borrows the configured model effort',()=>{
 const defaults={model:'gpt-6-astra',reasoningEffort:'xhigh'};
 const activeId=activeModelId('gpt-5-codex',defaults),view=configuredReasoningView(model,restoredReasoning(null),defaults,activeId);
 assert.equal(activeId,'gpt-5-codex');assert.equal(view.effective,null);assert.equal(view.configured,null);assert.equal(view.source,'unknown');assert.equal(view.configUnsupported,false);assert.equal(view.choices.length,3);
});
test('configured model outside the catalog keeps its name and reports unknown effort support',()=>{
 const defaults={model:'gpt-6-astra',reasoningEffort:'xhigh'};
 assert.equal(defaultModelView(catalog,'',defaults).displayName,'GPT-6 Astra');
 const missing=defaultModelView([model],'',defaults);
 assert.equal(missing.displayName,'gpt-6-astra（目录外）');assert.equal(missing.id,'gpt-6-astra');
 const view=configuredReasoningView(undefined,restoredReasoning(null),defaults,activeModelId('',defaults));
 assert.equal(view.effective,null);assert.equal(view.choices.length,0);assert.equal(view.configured,'xhigh');assert.equal(view.configUnsupported,false);assert.equal(view.configSupport,'unknown');assert.equal(view.source,'unknown');
});
test('switching to the configured model keeps its config effort; other models use their own supported stop',()=>{
 const defaults={model:'gpt-5-codex',reasoningEffort:'high'};
 assert.equal(reasoningParameter(switchedReasoning(model,restoredReasoning(null),{configuredModel:defaults.model,selectedModel:'gpt-5-codex'})),undefined);
 assert.equal(reasoningParameter(switchedReasoning(model,restoredReasoning(null),{configuredModel:defaults.model,selectedModel:'gpt-5-mini'})),'medium');
 assert.equal(reasoningParameter(switchedReasoning(model,{...restoredReasoning(null),override:'high'},{configuredModel:defaults.model,selectedModel:'gpt-5-codex'})),'high');
 assert.equal(reasoningParameter(switchedReasoning(model,{...restoredReasoning(null),override:'ultra'},{configuredModel:defaults.model,selectedModel:'gpt-5-mini'})),'medium');
});
