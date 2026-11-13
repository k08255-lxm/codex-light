import test from 'node:test';
import assert from 'node:assert/strict';
import {agentDisplayMetadata} from '../public/ui/agents.js';
import {DshTaskStore,dshSafeStatusResult,dshModelMetadata} from '../public/dsh.js';

test('native requested metadata remains explicitly requested until actual evidence exists',()=>{
  const requested=agentDisplayMetadata({native:true,requestedModel:'openai/gpt-6.1',requestedEffort:'high'});
  assert.deepEqual(requested.parts,['GPT','GPT-6.1','高']);
  assert.match(requested.title,/请求模型/);
  assert.match(requested.title,/尚无实际模型确认/);
  const actual=agentDisplayMetadata({native:true,requestedModel:'gpt-old',actualModel:'gpt-6.1',actualEffort:'medium'});
  assert.deepEqual(actual.parts,['GPT','GPT-6.1','中']);
  assert.match(actual.title,/实际报告模型/);
  assert.doesNotMatch(actual.title,/gpt-old/);
  assert.deepEqual(agentDisplayMetadata({native:true}).parts,['GPT']);
});

test('DSH model metadata is a bounded text projection, not a raw config projection',()=>{
  const projection=dshModelMetadata({model:'deepseek-v4',provider:'DSH Cloud',reasoning_effort:'high',api_key:'secret',config:{token:'secret'}});
  assert.deepEqual(projection,{model:'deepseek-v4',provider:'DSH Cloud',effort:'high'});
  assert.deepEqual(dshModelMetadata({model:{api_key:'secret'},provider:'x'.repeat(257),effort:'high\nsecret'}),{});
  const safe=dshSafeStatusResult({structuredContent:{agent_id:'a',status:'running',...projection,api_key:'secret'}});
  assert.doesNotMatch(JSON.stringify(safe),/secret|api_key/);
  const store=new DshTaskStore();store.reset('parent');
  store.ingestLiveStatus('parent','a',safe.structuredContent);
  const row=store.values()[0];
  assert.deepEqual(agentDisplayMetadata(row).parts,['DSH · DSH Cloud','DeepSeek-v4','高']);
  assert.equal(row.status,'running');
});
