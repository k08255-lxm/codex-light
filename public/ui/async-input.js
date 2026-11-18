// Native async questions arrive on agentMessage, not as a pending server request.
// Replies are explicit user messages; accepting the original tool call is not an answer.
let sequence = 0;

export function asyncInputDefinition(item) {
  if (item?.type !== 'agentMessage' || item.delivery !== 'async' || item.questions == null) return null;
  const questions = item.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 20) return { supported: false, reason: '问题列表无效。' };
  for (const question of questions) {
    if (!question || typeof question.title !== 'string' || !question.title.trim() || question.title.length > 4000) return { supported: false, reason: '问题文本无效。' };
    const options = question.options;
    if (options != null && (!Array.isArray(options) || options.length > 50 || options.some(option => typeof option !== 'string' || !option.trim() || option.length > 1000) || new Set(options).size !== options.length)) return { supported: false, reason: '问题选项无效。' };
  }
  return { supported: true, questions: questions.map(question => ({ title: question.title, options: question.options || [] })) };
}

// Native async messages repeat the form as plain text for clients without structured input support.
// Remove only the exact standalone fallback block; independent prose and unfamiliar formats stay visible.
export function asyncInputBodyText(item, source = item?.text ?? '') {
  let text = String(source);
  const definition = asyncInputDefinition(item);
  if (!definition?.supported) return text;
  for (const question of definition.questions) {
    const block = [question.title, ...question.options.map(option => '- ' + option)].join('\n');
    let offset = 0;
    while (offset <= text.length) {
      const start = text.indexOf(block, offset);
      if (start < 0) break;
      const end = start + block.length;
      if ((start === 0 || text[start - 1] === '\n') && (end === text.length || text[end] === '\n')) {
        const before = text.slice(0, start).replace(/\n+$/, '');
        const after = text.slice(end).replace(/^\n+/, '');
        text = before + (before && after ? '\n\n' : '') + after;
        offset = before.length;
      } else offset = end;
    }
  }
  return text;
}

const answerHeading = '对提问的回答\n\n';
const receiptKey = 'codex-light-async-answer-receipts';
let receipts;
globalThis.addEventListener?.('storage', event => { if (event.key === receiptKey || event.key === null) receipts = null; });
function answerReceipts() {
  if (receipts) return receipts;
  try { const saved = JSON.parse(globalThis.localStorage?.getItem(receiptKey) || '[]'); receipts = Array.isArray(saved) ? saved.filter(row=>row && typeof row==='object').slice(-512) : []; }
  catch { receipts = []; }
  return receipts;
}
// Only native IDs are stored. A reply that starts a new turn owns its first user input.
// Steered replies use the actual item ID assigned by the server once its echo is reconciled.
export function rememberAsyncAnswer(threadId, questionId, turnId, echoId = null) {
  if (!threadId || !questionId || !turnId) return;
  const rows=answerReceipts();
  const entry=rows.find(row=>row.threadId===threadId && row.questionId===questionId && row.turnId===turnId);
  if (entry && (!echoId || entry.echoId === echoId)) return;
  if (entry) entry.echoId=echoId;
  else { rows.push({threadId,questionId,turnId,echoId}); if(rows.length>512)rows.shift(); }
  try { globalThis.localStorage?.setItem(receiptKey,JSON.stringify(rows)); } catch { /* The in-memory association still applies. */ }
}

function answerText(answers) {
  return answerHeading + answers.map(({question, answer}, index) =>
    `${index + 1}. ${question}\n回答：${answer ?? '未回答'}`).join('\n\n');
}

function parseAnswers(text, questions) {
  const headings = questions.map(({title}, index) => `${index + 1}. ${title}\n回答：`);
  if (!text.startsWith(headings[0])) return null;
  const answers = [];
  let start = headings[0].length;
  for (let i = 0; i < headings.length; i++) {
    const next = headings[i + 1] && '\n\n' + headings[i + 1];
    const end = next ? text.indexOf(next, start) : text.length;
    if (end < 0 || (next && text.indexOf(next, end + next.length) >= 0)) return null;
    const answer = text.slice(start, end);
    if (!answer.trim()) return null;
    answers.push(answer);
    if (next) start = end + next.length;
  }
  return answers;
}

export function asyncAnswerHistory(turns, threadId) {
  const answered = new Map(), echoes = new Set(), pending = new Map();
  const known = threadId ? answerReceipts().filter(row=>row.threadId===threadId) : [];
  for (const turn of turns) {
    let legacy = [], firstInput = true;
    for (const item of turn.items || []) {
      if (item.type === 'agentMessage' && item.delivery === 'async') {
        const definition = asyncInputDefinition(item);
        if (definition?.supported) { pending.set(item.id, definition.questions); legacy.push(item.id); }
        continue;
      }
      if (item.type !== 'userMessage') continue;
      const first = firstInput; firstInput = false;
      const candidates = legacy;
      legacy = []; // Never claim a subsequent ordinary message as an old untagged reply.
      if (item.content?.length !== 1 || item.content[0]?.type !== 'text' || item._omitted?.['content.0'] || item._released?.['content.0']) continue;
      const text = item.content[0].text;
      if (typeof text !== 'string') continue;
      const claim = item._local ? item.id : item._echoClaim;
      const claimedId = typeof claim === 'string' && claim.startsWith('answer:') ? claim.slice(7) : '';
      if (claim && !claimedId) continue; // An ordinary composer submission owns this echo.
      const tagged = text.startsWith(answerHeading);
      if (!tagged && !text.startsWith('1. ')) continue;
      const receipt = known.find(row=>row.turnId===turn.id && (row.echoId ? row.echoId===item.id : first));
      const questionId = claimedId || receipt?.questionId;
      const matches = [];
      const source = tagged ? text.slice(answerHeading.length) : text;
      let candidateIds = tagged ? pending.keys() : candidates;
      if (questionId && (tagged || pending.has(questionId))) candidateIds = [questionId];
      for (const id of candidateIds) {
        const questions = pending.get(id);
        if (!questions) continue;
        const answers = parseAnswers(source, questions);
        if (answers) matches.push({id, answers});
      }
      if (matches.length !== 1) continue;
      const {id, answers} = matches[0];
      if (!item._local && tagged && (claimedId || receipt)) rememberAsyncAnswer(threadId,id,turn.id,item.id);
      pending.delete(id); answered.set(id, answers); echoes.add(item.id);
    }
  }
  return {answered, echoes};
}

export function createAsyncInputCard(document, initialItem, initialOptions = {}) {
  const uid = `async-input-${++sequence}`;
  const el = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text != null) node.textContent = text; return node; };
  const node = el('section', 'approval async-input-card');
  const title = el('h3', '', '需要你回答'); title.id = `${uid}-title`; title.setAttribute('aria-live','polite'); node.setAttribute('aria-labelledby', title.id);
  const body = el('div', 'approval-body');
  const status = el('p', 'approval-scope'); status.setAttribute('role', 'status');
  const error = el('p', 'inline-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const actions = el('div', 'actions');
  const progress=el('span','answer-progress');progress.setAttribute('aria-live','polite');
  const submit = el('button', 'accept answer-submit', '发送回答'); submit.type = 'button'; actions.append(progress,submit);
  node.append(title, body, status, error, actions);
  let item, options, signature, definition, readers = [], busy = false, outcome = null;
  function readAnswers() { return readers.map(reader => ({ question: reader.question, answer: reader.read() || null })); }
  function refresh() {
    const answered = readAnswers().filter(answer => answer.answer !== null).length;
    const available = !!options?.threadId && typeof options?.onAnswerAsync === 'function';
    for (const control of body.querySelectorAll('input,textarea,button')) control.disabled = busy || !!outcome;
    for (const [index, reader] of readers.entries()) { reader.summary.hidden = outcome?.status !== 'sent'; reader.summary.textContent = outcome?.answers?.[index] ?? (reader.read() || '未回答'); }
    submit.disabled = busy || !!outcome || !definition?.supported || !available || !answered;
    progress.textContent=definition?.supported?`已回答 ${answered} / ${readers.length}`:'';
    submit.textContent=busy?'正在发送…':outcome?.status==='queued'?'已加入队列':outcome?.status==='unknown'?'等待确认':'发送回答';
    node.dataset.outcome=outcome?.status||'';
    title.textContent=outcome?.status==='sent'?'已回答':'需要你回答';
    if (outcome?.status === 'sent') status.textContent = '';
    else if (busy) status.textContent = '正在发送回答…';
    else if (outcome) status.textContent = outcome.message || ({ queued: '已加入待发送队列', unknown: '发送结果待确认，请勿重复提交。' })[outcome.status];
    else if (!definition?.supported) status.textContent = definition?.reason || '';
    else if (!available) status.textContent = '当前无法发送回答，请在原对话中回复。';
    else status.textContent = answered && answered < readers.length ? `${readers.length - answered} 题未答` : '';
    status.hidden = !status.textContent;
    node.setAttribute('aria-busy', String(busy));
  }
  function build() {
    body.replaceChildren(); readers = [];
    if (!definition?.supported) return;
    for (const [index, question] of definition.questions.entries()) {
      const group = el('fieldset', 'approval-question');
      const legend = el('legend', '', question.title); legend.id = `${uid}-q${index}`; group.append(legend);
      const input = document.createElement('textarea'); input.rows = 2; input.maxLength = 20000;
      input.setAttribute('aria-labelledby', legend.id); input.spellcheck = false;
      let read = () => input.value.trim() ? input.value : null;
      if (question.options.length) {
        const radios = [];
        for (const labelText of [...question.options, '其他']) {
          const label = el('label', 'approval-choice'), radio = document.createElement('input');
          radio.type = 'radio'; radio.name = `${uid}-q${index}`; radio.checked = false;
          label.append(radio, el('span', '', labelText)); group.append(label); radios.push(radio);
          radio.addEventListener('change', () => { if (radio.checked) for (const other of radios) if (other !== radio) other.checked = false; refresh(); });
        }
        const other = radios.at(-1);
        input.classList.add('approval-other'); input.setAttribute('aria-label', `${question.title}：其他回答`);
        input.addEventListener('input', () => { if (input.value.trim()) { for (const radio of radios) radio.checked = radio === other; } refresh(); });
        read = () => other.checked ? (input.value.trim() ? input.value : null) : question.options.find((_, optionIndex) => radios[optionIndex].checked) || null;
      } else input.addEventListener('input', refresh);
      const summary=el('p','answer-value');summary.hidden=true;
      group.append(input,summary); body.append(group); readers.push({ question: question.title, read, summary });
    }
  }
  submit.addEventListener('click', async () => {
    if (submit.disabled || busy || outcome) return;
    const answers = readAnswers();
    if (!answers.some(answer => answer.answer !== null)) return;
    const payload = { threadId: options.threadId, itemId: item.id, answers, text: answerText(answers) };
    const submittedSignature = signature;
    busy = true; error.hidden = true; refresh();
    try {
      const result = await options.onAnswerAsync(payload);
      // A resolved callback alone is not evidence that a message was sent.
      if (signature === submittedSignature && !options.confirmedAnswers) outcome = result && ['sent', 'queued', 'unknown'].includes(result.status) ? result : { status: 'unknown' };
    } catch (cause) {
      if (signature === submittedSignature && !options.confirmedAnswers) { error.textContent = (cause?.message || '回答未能发送') + '。已填写的内容仍保留。'; error.hidden = false; }
    } finally { busy = false; refresh(); }
  });
  function update(nextItem, nextOptions = options) {
    item = nextItem; options = nextOptions; definition = asyncInputDefinition(item);
    const next = JSON.stringify(definition);
    if (signature !== next) { signature = next; outcome = null; error.hidden = true; build(); }
    if (options.confirmedAnswers) { outcome = {status: 'sent', answers: options.confirmedAnswers}; error.hidden = true; }
    refresh();
  }
  update(initialItem, initialOptions);
  return { node, update, dispose() { for (const input of body.querySelectorAll('input,textarea')) { input.value = ''; input.checked = false; } node.remove(); } };
}
