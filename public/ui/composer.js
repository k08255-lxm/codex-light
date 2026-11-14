// Composer submission controller: first send (draft → thread/start → turn/start), steer into a
// running turn, and the per-thread follow-up queue. Text moves immediately into a pending
// bubble; attachment cleanup waits for acknowledgement. Unknown outcomes are never replayed.
import { steerParams } from '../state.js';
import { outcomeFromError } from '../submissions.js';
import { reasoningParameter } from '../reasoning.js';
import { OptimisticMessages } from './optimistic-messages.js';

/**
 * Ports (explicit dependencies, grouped by responsibility):
 * - session: shared `state`, `followUps` queue, `sessionFor(threadId)`
 * - drafts: attachment drafts + previews, `clearSubmittedDraft`, `renderAttachments`, `autosizePrompt`
 * - ledger: `performMutation`, `pendingMutations`, `scopedPending`, `currentSendAvailability`, `renderPendingMutations`
 * - thread: `restoreThreadReasoning`, `loadThreads`, `syncStatus`, DSH resets for a new thread
 * - view: `$`, `el`, `notice`, `activity`, `updateControls`, `renderMessages`, `scheduleRender`, `scrollBottom`, `renderContext`, `openProjectDialog`, `openInlineCwd`
 */
export function createComposer({ document, session, drafts, ledger, thread, view }) {
  const { state, followUps, sessionFor, sessionControls } = session;
  const { attachmentDraft, fileAttachmentDraft, attachmentPreviews, queuedPreviews, clearSubmittedDraft, renderAttachments, autosizePrompt } = drafts;
  const { performMutation, pendingMutations, scopedPending, currentSendAvailability, renderPendingMutations } = ledger;
  const { restoreThreadReasoning, loadThreads, syncStatus, resetThreadDsh } = thread;
  const { $, el, notice, activity, confirm, openImage, updateControls, renderMessages, scheduleRender, scrollBottom, renderContext, openProjectDialog, openInlineCwd } = view;
  const optimistic=new OptimisticMessages();
  const optimisticHost=document.createElement('div');optimisticHost.id='optimistic-messages';optimisticHost.className='optimistic-messages';optimisticHost.hidden=true;
  const messages=$('messages');if(messages?.parentElement)messages.parentElement.append(optimisticHost);
  function beginOptimistic(draft,method='turn/start',retryId=null){
    const row=optimistic.begin({threadId:state.thread?.id||null,generation:state.openGeneration,...draft,method,beforeIds:state.store.values().filter(x=>x.type==='userMessage'&&!x._local).map(x=>x.id)});
    if(retryId)optimistic.remove(retryId);
    $('prompt').value='';autosizePrompt();renderOptimistic();scrollBottom();return row;
  }
  function restoreUnsentText(row){
    if(row.status==='notExecuted'&&state.openGeneration===row.generation&&(state.thread?.id||null)===row.threadId&&!$('prompt').value) { $('prompt').value=row.text;autosizePrompt(); }
  }
  function resolveOptimistic(marker,response,decision){
    optimistic.resolve(marker.requestId,decision,response?.result,response?.error||'');
    for(const row of optimistic.rows.values())if(row.requestId===marker.requestId)restoreUnsentText(row);
    renderOptimistic();
  }
  function retryOptimistic(row){
    if(row.status!=='notExecuted'||state.sending||state.loadingThread||!state.connected)return;
    const current=draftSnapshot();
    const sameIds=(a,b)=>a.length===b.length&&a.every((x,i)=>x.id===b[i].id);
    if(current.text&&current.text!==row.text||!sameIds(current.images,row.images)||!sameIds(current.files,row.files)) {notice('草稿或附件已改变，请检查输入框后手动发送。原消息未重发。');return;}
    $('prompt').value=row.text;autosizePrompt();send('auto',row.id);
  }
  function renderOptimistic(){
    optimistic.reconcile(state.thread?.id||null,state.store.values());
    const rows=optimistic.visible(state.thread?.id||null,state.openGeneration);const fragment=document.createDocumentFragment();
    for(const row of rows){
      const article=el('article','message userMessage optimistic-message');article.dataset.submission=row.id;article.dataset.status=row.status;
      const body=el('div','message-text');if(row.text)body.append(el('div','message-bubble',row.text));
      const names=[...row.images,...row.files].map(x=>x.name||'附件');if(names.length)body.append(el('div','optimistic-attachments',names.join(' · ')));
      const labels={sending:'正在发送…',accepted:'已发送，正在同步…',notExecuted:'未发送',failed:'发送失败，请核对结果',unknown:'结果待确认，请勿重复发送'};
      const status=el('div','optimistic-status',labels[row.status]);status.setAttribute('role','status');if(row.error)status.title=row.error;
      article.append(body,status);
      if(row.status==='notExecuted'){const retry=el('button','btn ghost small','重新发送');retry.type='button';retry.disabled=state.sending||!state.connected;retry.addEventListener('click',()=>retryOptimistic(row));article.append(retry);}
      if(['failed','notExecuted'].includes(row.status)){const dismiss=el('button','btn ghost small','移除此提示');dismiss.type='button';dismiss.addEventListener('click',()=>{optimistic.remove(row.id);renderOptimistic();});article.append(dismiss);}
      fragment.append(article);
    }
    optimisticHost.replaceChildren(fragment);optimisticHost.hidden=!rows.length;
    if(rows.length)$('welcome').classList.add('hidden');
  }
  // ---------- Composer: send, steer, queue ----------
  function draftSnapshot() {
    return { text: $('prompt').value.trim(), images: attachmentDraft.values(), files: fileAttachmentDraft.values() };
  }
  function hasDraft() { const d = draftSnapshot(); return !!(d.text || d.images.length || d.files.length); }
  function threadBusy(threadId) {
    if (!threadId) return false;
    if (threadId === state.thread?.id) return state.busy;
    return state.activeTurns.has(threadId) || !!sessionFor(threadId)?.activeTurnId;
  }
  /** Running-task input is possible only with a known active turn on a connected, idle-sending client. */
  function runningInputAvailable() {
    // Steer is only valid for a turn this bridge owns; reading history of someone else's task never subscribes.
    const owned = sessionFor(state.thread?.id)?.activeTurnId === state.turnId;
    return !!(owned && state.busy && state.thread && state.turnId && state.connected && state.serverInstance && !state.sending && !state.loadingThread && !state.uploadingImages && !pendingMutations.storageError && !scopedPending('chat',{threadId:state.thread.id}).length);
  }
  function confirmRiskyFiles(files) {
    const risky = files.filter(file => file.riskWarning);
    if (!risky.length) return [];
    if (!confirm('以下文件属于归档或未验证格式：\n' + risky.map(file => file.name + (file.warning ? '：' + file.warning : '')).join('\n') + '\n\n只将本地文件引用交给 Codex，可能按现有权限读取；不会自动解包或执行。确认随本次消息发送？')) return null;
    return risky.map(file => file.id);
  }
  function imageCapabilityError(images) {
    const selectedModel = state.models.find(model => model.model === $('model').value);
    return images.length && Array.isArray(selectedModel?.inputModalities) && !selectedModel.inputModalities.includes('image') ? '所选模型未声明图片输入能力。请选择支持图片的模型，或移除附件。' : '';
  }
  async function send(mode = 'auto', retryId = null) {
    if(state.sending)return;
    if (state.busy && state.thread && mode !== 'start') return mode === 'queue' ? queueDraft() : steerDraft(retryId);
    const availability=currentSendAvailability();if(availability.disabled){notice(availability.reason);if(availability.action==='cwd')openInlineCwd();else if(availability.action==='pending')$('pending-submissions').scrollIntoView({block:'nearest'});return;}
    const draft = draftSnapshot(); if (!draft.text && !draft.images.length && !draft.files.length) return;
    const capability = imageCapabilityError(draft.images); if (capability) { notice(capability, true); return; }
    if (!state.cwd) { openProjectDialog(); return; }
    const confirmed = confirmRiskyFiles(draft.files); if (confirmed === null) return;
    // One immutable logical submission: navigation/model/cwd edits cannot retarget its second stage.
    const submission = { cwd: state.cwd, model: $('model').value, effort: reasoningParameter(state.reasoning), text: draft.text, attachmentIds: attachmentDraft.ids(), fileAttachmentIds:fileAttachmentDraft.ids(), confirmedFileAttachmentIds:confirmed };
    try { submission.controls=sessionControls.snapshot(); } catch(error){notice(error.message,true);return;}
    state.sending = true; const optimisticRow=beginOptimistic(draft,'turn/start',retryId);updateControls(); activity('正在发送…'); const generation = state.openGeneration;
    try {
      if (!state.thread) {
        // The draft becomes a real thread only now, immediately before its first turn.
        const params = { cwd: submission.cwd }; if (submission.model) params.model = submission.model;
        Object.assign(params,sessionControls.params(submission.controls,'thread'));
        const result = await performMutation('thread/start', params,{onRequest:envelope=>optimistic.patch(optimisticRow.id,{requestId:envelope.requestId,method:'thread/start'})}); optimistic.patch(optimisticRow.id,{threadId:result.thread.id});if (generation !== state.openGeneration) { optimistic.patch(optimisticRow.id,{status:'notExecuted',error:'已切换对话，消息未发送。'});renderOptimistic();notice('新对话已创建；你已切换页面，因此消息未继续发送。'); return; }
        sessionControls.adopt(result.thread.id);
        state.thread = result.thread; restoreThreadReasoning(result, submission.effort); resetThreadDsh(state.thread.id); $('thread-title').textContent = submission.text.slice(0, 55) || '附件对话'; $('welcome').classList.add('hidden'); renderContext();
      }
      const params = { threadId: state.thread.id, cwd: submission.cwd, input: [{ type: 'text', text: submission.text }] }; if (submission.model) params.model = submission.model; if (submission.effort) params.effort = submission.effort;
      Object.assign(params,sessionControls.params(submission.controls,'turn'));
      const result = await performMutation('turn/start', params, { attachmentIds: submission.attachmentIds, fileAttachmentIds:submission.fileAttachmentIds, confirmedFileAttachmentIds:submission.confirmedFileAttachmentIds,onRequest:envelope=>optimistic.patch(optimisticRow.id,{requestId:envelope.requestId,method:'turn/start'}) });
      optimistic.patch(optimisticRow.id,{status:'accepted',turnId:result.turn?.id});renderOptimistic();
      clearSubmittedDraft({ preserveText:true, method: 'turn/start', params, attachmentIds: submission.attachmentIds, fileAttachmentIds:submission.fileAttachmentIds });
      if (generation !== state.openGeneration) { notice('消息已发送到原对话，未发送到当前页面。'); return; }
      if (submission.effort) state.reasoning.inherited = submission.effort;
      acceptStartedTurn(params.threadId, result.turn);
      loadThreads().catch(() => {}); scrollBottom();
    } catch (e) {
      const outcome = outcomeFromError(e);
      optimistic.patch(optimisticRow.id,{status:outcome,error:e.message});restoreUnsentText(optimisticRow);renderOptimistic();
      notice(outcome === 'unknown' ? `请求结果未知：${e.message}。正在自动同步消息状态，不会自动重发。` : `请求未完成：${e.message}。${outcome === 'notExecuted' ? '服务确认该请求未执行，草稿已保留。' : '服务返回明确失败；请检查是否有部分改动。'}没有自动重发。`, true);
      activity(outcome === 'unknown' ? '请求结果未知，请确认后再继续' : '请求未完成');
    } finally { state.sending = false; renderOptimistic(); renderPendingMutations(); updateControls(); drainAll(); }
  }
  /** Records a confirmed turn/start for whichever thread it belongs to. */
  function acceptStartedTurn(threadId, turn) {
    const id = turn?.id; const running = !!id && !state.terminalTurns.has(id) && !['completed', 'failed', 'interrupted'].includes(turn?.status);
    if (id) state.ledger.merge(turn, { observedStartMs: Date.now() });
    if (threadId !== state.thread?.id) { if (running) state.activeTurns.set(threadId, id); return; }
    state.turnId = running ? id : null; state.busy = running;
    if (running) state.ledger.activate(id, Date.now());
    activity(''); renderMessages(); updateControls();
  }
  /** Adds guidance to the running turn. Clears the draft only after the bridge confirms. */
  async function steerDraft(retryId=null) {
    if (!runningInputAvailable()) { notice('当前任务状态未确认，暂不能立即补充。可排队，或等待任务结束。'); return; }
    const draft = draftSnapshot(); if (!draft.text && !draft.images.length && !draft.files.length) return;
    const capability = imageCapabilityError(draft.images); if (capability) { notice(capability, true); return; }
    const confirmed = confirmRiskyFiles(draft.files); if (confirmed === null) return;
    const threadId = state.thread.id, turnId = state.turnId;
    let params; try { params = steerParams(threadId, turnId, draft.text); } catch (error) { notice(error.message, true); return; }
    const extras = { attachmentIds: attachmentDraft.ids(), fileAttachmentIds: fileAttachmentDraft.ids(), confirmedFileAttachmentIds: confirmed };
        state.sending = true; const optimisticRow=beginOptimistic(draft,'turn/steer',retryId);optimistic.patch(optimisticRow.id,{turnId});updateControls(); activity('正在补充到当前任务…');
    try {
      const result = await performMutation('turn/steer', params, {...extras,onRequest:envelope=>optimistic.patch(optimisticRow.id,{requestId:envelope.requestId})});
      optimistic.patch(optimisticRow.id,{status:'accepted',turnId:result.turnId||turnId});renderOptimistic();
      clearSubmittedDraft({ preserveText:true, method: 'turn/steer', params, ...extras });
      scheduleRender();
      activity('');
    } catch (e) {
      const outcome = outcomeFromError(e);
      optimistic.patch(optimisticRow.id,{status:outcome,error:e.message});restoreUnsentText(optimisticRow);renderOptimistic();
      if (e.code === 'ACTIVE_TURN_MISMATCH') { notice('运行中的任务已经变化，补充未发送，草稿已保留。可重新选择立即补充或排队。', true); syncStatus().catch(() => {}); }
      else notice(outcome === 'unknown' ? `补充结果未知：${e.message}。正在自动同步，不会重发；草稿已保留，请先确认再决定。` : `补充未发送：${e.message}。草稿已保留。`, true);
      activity('');
    } finally { state.sending = false; renderOptimistic(); renderPendingMutations(); updateControls(); }
  }
  /** Moves the draft into this thread's ordered queue. Nothing is sent yet. */
  function queueDraft() {
    if (!state.thread || state.sending || pendingMutations.storageError || scopedPending('chat',{threadId:state.thread.id}).length) return;
    const draft = draftSnapshot(); if (!draft.text && !draft.images.length && !draft.files.length) return;
    const capability = imageCapabilityError(draft.images); if (capability) { notice(capability, true); return; }
    const confirmed = confirmRiskyFiles(draft.files); if (confirmed === null) return;
    try {
      const item = followUps.add(state.thread.id, { controls:sessionControls.snapshot(), text: draft.text, images: draft.images, files: draft.files, confirmedFileAttachmentIds: confirmed, cwd: state.thread.cwd || state.cwd, model: $('model').value, effort: reasoningParameter(state.reasoning) });
      // Ownership of attachments and their previews moves to the queued item.
      for (const image of draft.images) { const url = attachmentPreviews.get(image.id); if (url) queuedPreviews.set(image.id, url); attachmentPreviews.delete(image.id); attachmentDraft.remove(image.id); }
      for (const file of draft.files) fileAttachmentDraft.remove(file.id);
      $('prompt').value = ''; autosizePrompt(); renderAttachments(); renderQueue(); updateControls();
      if (!threadBusy(state.thread.id)) drainQueue(state.thread.id);
      return item;
    } catch (error) { notice(error.message, true); }
  }
  function releaseQueuedPreviews(item) { for (const image of item.images || []) { const url = queuedPreviews.get(image.id); if (url) URL.revokeObjectURL(url); queuedPreviews.delete(image.id); } }
  const draining = new Set();
  function drainAll() { for (const threadId of followUps.threadIds()) drainQueue(threadId); }
  /** Sends exactly the head of one thread's queue after the thread is idle. Never retries automatically. */
  async function drainQueue(threadId) {
    if (draining.has(threadId) || !state.connected || !state.serverInstance || state.sending || pendingMutations.storageError) return;
    if (threadBusy(threadId) || scopedPending('chat', { threadId }).length) return;
    const item = followUps.next(threadId); if (!item) return;
    draining.add(threadId); followUps.update(threadId, item.id, { status: 'sending', error: '' }); renderQueue();
    const params = { threadId, cwd: item.cwd, input: [{ type: 'text', text: item.text }] }; if (item.model) params.model = item.model; if (item.effort) params.effort = item.effort;
    try {
      Object.assign(params,sessionControls.params(item.controls,'turn'));
      const result = await performMutation('turn/start', params, { attachmentIds: item.images.map(image => image.id), fileAttachmentIds: item.files.map(file => file.id), confirmedFileAttachmentIds: item.confirmedFileAttachmentIds });
      followUps.update(threadId, item.id, { status: 'sent' }); followUps.remove(threadId, item.id); releaseQueuedPreviews(item);
      acceptStartedTurn(threadId, result.turn);
    } catch (e) {
      const outcome = outcomeFromError(e);
      followUps.update(threadId, item.id, { status: outcome === 'unknown' ? 'unknown' : 'failed', error: e.message });
      followUps.pause(threadId, outcome === 'unknown' ? '上一条排队消息结果未知' : '上一条排队消息未发送');
      notice(outcome === 'unknown' ? `排队消息结果未知：${e.message}。队列已暂停，不会重发。` : `排队消息未发送：${e.message}。队列已暂停，可编辑后重试。`, true);
    } finally { draining.delete(threadId); renderQueue(); renderPendingMutations(); updateControls(); }
  }
  function renderQueue() {
    const host = $('queue'); const threadId = state.thread?.id;
    const rows = threadId ? followUps.list(threadId) : [];
    host.classList.toggle('hidden', !rows.length);
    if (!rows.length) { host.replaceChildren(); return; }
    const head = el('div', 'queue-head');
    const paused = followUps.pausedReason(threadId);
    head.append(el('span', 'queue-title', `已排队 ${rows.length} 条`));
    if(paused)head.append(el('span','queue-note',`已暂停 · ${paused}`));
    if (paused) {
      const resume = el('button', 'queue-action', '继续发送'); resume.type = 'button';
      resume.disabled = rows[0]?.status !== 'queued';
      resume.title = resume.disabled ? '先处理第一条（编辑、重试或移除）' : '恢复队列，任务空闲时发送第一条';
      resume.addEventListener('click', () => { followUps.resume(threadId); renderQueue(); drainQueue(threadId); });
      head.append(resume);
    }
    const list = el('ol', 'queue-list');
    for (const row of rows) {
      const li = el('li', 'queue-item'); li.dataset.status = row.status;
      const body = el('div', 'queue-text', row.text || '（仅附件）');
      const meta = [];
      if (row.images.length) meta.push(`${row.images.length} 张图片`);
      if (row.files.length) meta.push(`${row.files.length} 个文件`);
      if (row.status === 'sending') meta.push('正在发送…');
      if (row.status === 'failed') meta.push('未发送：' + row.error);
      if (row.status === 'unknown') meta.push('结果未知，可能已发送：' + row.error);
      li.append(body); if (meta.length) li.append(el('small', 'queue-meta', meta.join(' · ')));
      if(row.images.length){const media=el('div','queue-images');for(const image of row.images){const url=queuedPreviews.get(image.id);if(!url)continue;const button=el('button','attachment-preview');button.type='button';button.setAttribute('aria-label','预览 '+image.name);const preview=el('img');preview.src=url;preview.alt=image.name||'排队图片';button.append(preview);button.addEventListener('click',()=>openImage?.({url,name:image.name||'图片'}));media.append(button);}li.append(media);}
      const actions = el('div', 'queue-item-actions');
      if (row.status !== 'sending') {
        const edit = el('button', 'queue-action', '编辑'); edit.type = 'button';
        edit.addEventListener('click', () => editQueued(threadId, row, li));
        const remove = el('button', 'queue-action', '移除'); remove.type = 'button';
        remove.addEventListener('click', () => { const removed = followUps.remove(threadId, row.id); if (removed) releaseQueuedPreviews(removed); if (!followUps.size(threadId)) followUps.resume(threadId); renderQueue(); updateControls(); });
        actions.append(edit);
        if (row.status === 'failed') { const retry = el('button', 'queue-action', '重试'); retry.type = 'button'; retry.addEventListener('click', () => { followUps.update(threadId, row.id, { status: 'queued', error: '' }); followUps.resume(threadId); renderQueue(); drainQueue(threadId); }); actions.append(retry); }
        actions.append(remove);
      }
      li.append(actions); list.append(li);
    }
    host.replaceChildren(head, list);
  }
  function editQueued(threadId, row, li) {
    const area = el('textarea', 'queue-edit'); area.value = row.text; area.rows = 2; area.setAttribute('aria-label', '编辑排队消息');
    const save = el('button', 'queue-action', '保存'); save.type = 'button';
    const cancel = el('button', 'queue-action', '取消'); cancel.type = 'button';
    const finish = keep => { if (keep) followUps.update(threadId, row.id, { text: area.value.trim(), status: row.status === 'unknown' ? 'unknown' : row.status === 'failed' ? 'failed' : 'queued' }); renderQueue(); };
    save.addEventListener('click', () => finish(true)); cancel.addEventListener('click', () => finish(false));
    area.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); finish(false); } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); finish(true); } });
    const actions = el('div', 'queue-item-actions'); actions.append(save, cancel);
    li.replaceChildren(area, actions); area.focus();
  }


  return { renderOptimistic,resolveOptimistic, send, steerDraft, queueDraft, hasDraft, runningInputAvailable, drainAll, drainQueue, renderQueue, acceptStartedTurn };
}
