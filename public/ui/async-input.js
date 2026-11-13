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

export function createAsyncInputCard(document, initialItem, initialOptions = {}) {
  const uid = `async-input-${++sequence}`;
  const el = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text != null) node.textContent = text; return node; };
  const node = el('section', 'approval async-input-card');
  const title = el('h3', '', '需要你回答'); title.id = `${uid}-title`; node.setAttribute('aria-labelledby', title.id);
  const body = el('div', 'approval-body');
  const status = el('p', 'approval-scope'); status.setAttribute('role', 'status');
  const error = el('p', 'inline-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const actions = el('div', 'actions');
  const submit = el('button', 'accept', '提交回答'); submit.type = 'button'; actions.append(submit);
  node.append(title, body, status, error, actions);
  let item, options, signature, definition, readers = [], busy = false, outcome = null;
  function readAnswers() { return readers.map(reader => ({ question: reader.question, answer: reader.read() || null })); }
  function refresh() {
    const answered = readAnswers().filter(answer => answer.answer !== null).length;
    const available = !!options?.threadId && typeof options?.onAnswerAsync === 'function';
    for (const control of body.querySelectorAll('input,textarea,button')) control.disabled = busy || !!outcome;
    submit.disabled = busy || !!outcome || !definition?.supported || !available || !answered;
    if (busy) status.textContent = '正在发送回答…';
    else if (outcome) status.textContent = outcome.message || ({ sent: '已回复', queued: '已加入待发送队列', unknown: '发送结果待确认，请勿重复提交。' })[outcome.status];
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
      group.append(input); body.append(group); readers.push({ question: question.title, read });
    }
  }
  submit.addEventListener('click', async () => {
    if (submit.disabled || busy || outcome) return;
    const answers = readAnswers();
    if (!answers.some(answer => answer.answer !== null)) return;
    const payload = { threadId: options.threadId, itemId: item.id, answers, text: answers.map((answer, index) => `${index + 1}. ${answer.question}\n回答：${answer.answer === null ? '未回答' : answer.answer}`).join('\n\n') };
    const submittedSignature = signature;
    busy = true; error.hidden = true; refresh();
    try {
      const result = await options.onAnswerAsync(payload);
      // A resolved callback alone is not evidence that a message was sent.
      if (signature === submittedSignature) outcome = result && ['sent', 'queued', 'unknown'].includes(result.status) ? result : { status: 'unknown' };
    } catch (cause) {
      if (signature === submittedSignature) { error.textContent = (cause?.message || '回答未能发送') + '。已填写的内容仍保留。'; error.hidden = false; }
    } finally { busy = false; refresh(); }
  });
  function update(nextItem, nextOptions = options) {
    item = nextItem; options = nextOptions; definition = asyncInputDefinition(item);
    const next = JSON.stringify(definition);
    if (signature !== next) { signature = next; outcome = null; error.hidden = true; build(); }
    refresh();
  }
  update(initialItem, initialOptions);
  return { node, update, dispose() { for (const input of body.querySelectorAll('input,textarea')) { input.value = ''; input.checked = false; } node.remove(); } };
}
