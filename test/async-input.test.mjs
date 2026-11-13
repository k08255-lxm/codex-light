import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, visibleText } from './mini-dom.mjs';
import { asyncInputDefinition, asyncInputBodyText, createAsyncInputCard } from '../public/ui/async-input.js';
import { mountConversation } from '../public/activity-feed.js';
import { createAgentInspector } from '../public/ui/agent-inspector.js';
import { TurnLedger, buildTurns } from '../public/state.js';

const question = { id: 'ask-one', type: 'agentMessage', delivery: 'async', text: '请选择', _turnId: 'turn-one', _complete: true, questions: [{ title: '怎样生成标题？', options: ['模型总结（推荐）', '本地提炼'] }, { title: '补充说明', options: null }] };
const fallback = questions => questions.map(question => [question.title,...(question.options||[]).map(option=>'- '+option)].join('\n')).join('\n\n');
const click = async button => { if (!button.disabled) for (const listener of button.listeners.click || []) await listener({}); };
function form(options = {}) {
  const document = createDocument(), posted = [];
  const opts = { threadId: 'main-thread', onAnswerAsync: async payload => { posted.push(payload); return { status: 'sent' }; }, ...options };
  const card = createAsyncInputCard(document, question, opts); document.body.append(card.node);
  return { ...card, document, posted, opts, submit: card.node.querySelector('button') };
}

test('only native async message questions become an async form; tool accepted is not an answer', () => {
  assert.equal(asyncInputDefinition({ type: 'agentMessage', text: JSON.stringify(question.questions) }), null);
  assert.equal(asyncInputDefinition({ type: 'functionCallOutput', name: 'request_user_input_async', output: '{"accepted":true}' }), null);
  assert.equal(asyncInputDefinition(question).supported, true);
  assert.equal(asyncInputDefinition({ ...question, questions: [{ title: 'bad', options: [42] }] }).supported, false);
});

test('only exact standalone native fallback question blocks are removed, with other explanations retained', () => {
  const observed={...question,text:'是否改用 Playwright 给本地预览截图并检查动画？\n- 改用 Playwright（推荐）\n- 继续修复原截图宿主',questions:[{title:'是否改用 Playwright 给本地预览截图并检查动画？',options:['改用 Playwright（推荐）','继续修复原截图宿主']}]};
  assert.equal(asyncInputBodyText(observed),'');
  const text=fallback(question.questions);
  assert.equal(asyncInputBodyText({...question,text}), '');
  assert.equal(asyncInputBodyText({...question,text:'独立说明。\n\n'+text+'\n\n完成选择后继续。'}), '独立说明。\n\n完成选择后继续。');
  const interleaved='请先选择。\n\n'+fallback(question.questions.slice(0,1))+'\n\n这是第二题的额外说明。\n\n补充说明';
  assert.equal(asyncInputBodyText({...question,text:interleaved}), '请先选择。\n\n这是第二题的额外说明。');
  const first=fallback(question.questions.slice(0,1));
  for(const item of [{...question,delivery:'normal',text},{...question,questions:[{title:'bad',options:[42]}],text},{...question,questions:question.questions.slice(0,1),text:'引述：'+first},{...question,questions:question.questions.slice(0,1),text:first+'（额外要求）'}])assert.equal(asyncInputBodyText(item),item.text);
});

test('conversation shows native questions once while preserving independent explanations and input drafts', () => {
  const document=createDocument(),host=document.createElement('div');document.body.append(host);
  const view=mountConversation(host,{getThreadId:()=> 'parent',onAnswerAsync:async()=>({status:'sent'})});
  const ledger=new TurnLedger();ledger.merge({id:'turn-one',status:'inProgress'});
  const item={...question,text:fallback(question.questions)};
  view.render(buildTurns([item],ledger,{activeTurnId:'turn-one'}));
  assert.equal(host.querySelector('.message-text').hidden,true);
  const form=host.querySelector('.async-input-card'),draft=host.querySelector('.approval-other');draft.value='保留草稿';draft.dispatch('input');
  view.render(buildTurns([{...item,text:'额外背景。\n\n'+item.text+'\n\n提交后继续。'}],ledger,{activeTurnId:'turn-one'}));
  assert.equal(host.querySelector('.async-input-card'),form);assert.equal(host.querySelector('.approval-other'),draft);assert.equal(draft.value,'保留草稿');
  assert.equal(host.querySelector('.message-text').hidden,false);
  const body=host.querySelector('.message-text').textContent;assert.match(body,/额外背景/);assert.match(body,/提交后继续/);assert.doesNotMatch(body,/怎样生成标题|模型总结|本地提炼|补充说明/);
});

test('recommended options start unchecked and only an explicit submit sends selected answers', async () => {
  const view = form(), radios = view.node.querySelectorAll('input');
  assert.ok(radios.every(radio => radio.checked === false));
  assert.equal(view.submit.disabled, true); await click(view.submit); assert.equal(view.posted.length, 0);
  radios[1].checked = true; radios[1].dispatch('change');
  assert.equal(view.posted.length, 0); assert.equal(view.submit.disabled, false);
  await click(view.submit);
  assert.equal(view.posted.length, 1);
  assert.deepEqual(view.posted[0].answers, [{ question: '怎样生成标题？', answer: '本地提炼' }, { question: '补充说明', answer: null }]);
  assert.equal(view.posted[0].threadId, 'main-thread'); assert.equal(view.posted[0].itemId, 'ask-one');
  assert.match(view.posted[0].text, /回答：本地提炼/); assert.match(view.posted[0].text, /回答：未回答/);
  assert.doesNotMatch(view.posted[0].text, /回答：模型总结/);
  assert.match(visibleText(view.node), /已回复/); assert.equal(view.submit.disabled, true);
});

test('typing Other is explicit and a pending submit preserves drafts through identical history updates', async () => {
  let finish; const view = form({ onAnswerAsync: () => new Promise(resolve => { finish = resolve; }) });
  const custom = view.node.querySelector('.approval-other'); custom.value = '我的自定义方式'; custom.dispatch('input');
  const pending = click(view.submit);
  assert.equal(view.submit.disabled, true);
  view.update(structuredClone(question), view.opts);
  assert.equal(view.node.querySelector('.approval-other'), custom); assert.equal(custom.value, '我的自定义方式');
  assert.match(visibleText(view.node), /正在发送/);
  finish({ status: 'queued' }); await pending;
  assert.match(visibleText(view.node), /已加入待发送队列/); assert.doesNotMatch(visibleText(view.node), /已回复/);
  assert.equal(custom.value, '我的自定义方式');
});

test('send failure retains input; absent acknowledgement never claims an answer was sent', async () => {
  const view = form({ onAnswerAsync: async () => { throw new Error('发送被拒绝'); } });
  const custom = view.node.querySelector('.approval-other'); custom.value = '保留草稿'; custom.dispatch('input');
  await click(view.submit); assert.equal(custom.value, '保留草稿'); assert.equal(view.submit.disabled, false);
  assert.match(visibleText(view.node), /发送被拒绝/);
  view.update(question, { ...view.opts, onAnswerAsync: async () => ({ accepted: true }) });
  await click(view.submit);
  assert.match(visibleText(view.node), /发送结果待确认/); assert.doesNotMatch(visibleText(view.node), /已回复/);
  assert.equal(view.submit.disabled, true); assert.equal(custom.value, '保留草稿');
});

test('the conversation renders async questions even without text and reuses their input across deltas', () => {
  const document = createDocument(), host = document.createElement('div'); document.body.append(host);
  const view = mountConversation(host, { getThreadId: () => 'parent', onAnswerAsync: async () => ({ status: 'sent' }) });
  const ledger = new TurnLedger(); ledger.merge({ id: 'turn-one', status: 'inProgress' });
  const item = { ...question, text: '' };
  view.render(buildTurns([item], ledger, { activeTurnId: 'turn-one' }));
  const custom = host.querySelector('.approval-other'); assert.ok(custom); custom.value = '保存正在输入'; custom.dispatch('input');
  view.render(buildTurns([{ ...item, text: '新增上下文说明' }], ledger, { activeTurnId: 'turn-one' }));
  assert.equal(host.querySelector('.approval-other'), custom); assert.equal(custom.value, '保存正在输入');
  view.clear(); view.render(buildTurns([item], ledger));
  assert.equal(host.querySelector('.approval-other'), custom, 'returning to the same thread does not erase the draft');
});

test('native subagent forms send to their own thread and survive inspector refresh; compaction stays outside details', async () => {
  const document = createDocument(), host = document.createElement('div'); document.body.append(host);
  const el = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text != null) node.textContent = text; return node; };
  const state = { connected: true, thread: { id: 'parent' }, store: { values: () => [{ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'completed' } } }] } };
  const posted = [];
  const inspector = createAgentInspector({ document, state, host, el,
    dshTasks: { values: () => [] }, dshLive: { selectAgent() {} },
    rpc: async method => { assert.equal(method, 'thread/read'); return { thread: { id: 'child', turns: [{ id: 'turn-one', status: 'completed', items: [{ id: 'before', type: 'commandExecution', command: 'echo before' }, { id: 'compact', type: 'contextCompaction' }, {...question,text:'子代理的额外说明。\n\n'+fallback(question.questions)}] }] } }; },
    onAnswerAsync: async payload => { posted.push(payload); return { status: 'sent' }; }
  });
  inspector.render(); assert.equal(inspector.open('child', 'native'), true);
  await new Promise(resolve => setImmediate(resolve));
  const custom = host.querySelector('.approval-other'); assert.ok(custom); custom.value = 'child only'; custom.dispatch('input');
  const prose=host.querySelectorAll('.agent-markdown').map(node=>node.textContent).join('\n');assert.match(prose,/子代理的额外说明/);assert.doesNotMatch(prose,/怎样生成标题|模型总结|本地提炼|补充说明/);
  custom.focus(); inspector.render();
  assert.equal(host.querySelector('.approval-other'), custom); assert.equal(document.activeElement, custom);
  const compact = host.querySelector('.compaction-record'); assert.ok(compact); assert.equal(compact.closest('details'), null);
  await click(host.querySelector('.async-input-card').querySelector('button'));
  assert.equal(posted.length, 1); assert.equal(posted[0].threadId, 'child'); assert.equal(posted[0].itemId, question.id);
});
