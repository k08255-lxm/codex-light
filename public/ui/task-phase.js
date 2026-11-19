const tools = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageGeneration', 'imageView']);
const deltaPhases = new Map([
  ['item/agentMessage/delta', 'responding'],
  ['item/reasoning/textDelta', 'thinking'], ['item/reasoning/summaryTextDelta', 'thinking'],
  ['item/commandExecution/outputDelta', 'tool'], ['item/mcpToolCall/progress', 'tool'], ['item/fileChange/patchUpdated', 'tool'],
]);

// Keep identifiers and phase labels only. Overlapping tools can finish in a different order.
export function createTurnActivity(turnId) {
  const active = new Map(), finished = new Set();
  return {
    turnId,
    get phase() {return [...active.values()].at(-1) || 'working';},
    observe({method, params}) {
      const item = params?.item, id = item?.id || params?.itemId;
      if (typeof id !== 'string' || !id || id.length > 256 || finished.has(id)) return;
      if (method === 'item/completed') {
        active.delete(id);
        finished.add(id);
        if (finished.size > 256) finished.delete(finished.values().next().value);
        return;
      }
      const phase = method === 'item/started'
        ? item?.type === 'reasoning' ? 'thinking' : tools.has(item?.type) ? 'tool'
          : item?.type === 'agentMessage' && item.delivery !== 'async' ? 'responding' : null
        : deltaPhases.get(method);
      if (phase && !active.has(id)) {
        active.set(id,phase);
        if (active.size > 128) active.delete(active.keys().next().value);
      }
    },
  };
}

export function waitingPhase(notices, threadId, turnId) {
  return notices.find(notice => {
    const requestedTurn = notice.turnId || notice.request?.params?.turnId;
    return notice.threadId === threadId && (!requestedTurn || requestedTurn === turnId);
  })?.kind;
}
