/** Only confirmed root turns, short conversation titles and aggregate activity reach the desktop. */
export function createDesktopCompanion(post) {
  const state = { character: 'off', size: 100, dark: false, reducedMotion: false, connected: false,
    running: 0, agents: 0, taskNames: [], phase: 'work', questions: 0, approvals: 0, quota: [], stale: false };
  let names = new Map(), turns = new Map(), terminal = new Set(), activities = [], backgroundAgents = 0;
  let queued = false, previous = '';
  function update(change) {
    Object.assign(state, change);
    if (!post || queued || (state.character === 'off' && !previous)) return;
    queued = true;
    // Reconnection, account resets and turn events can update several sources in one tick.
    queueMicrotask(() => {
      queued = false;
      const live = state.connected ? state : { ...state, running: 0, agents: 0, taskNames: [], phase: 'work', questions: 0, approvals: 0, quota: [], stale: false };
      const message = state.character === 'off' ? { type: 'desktopCompanion', character: 'off' } : { type: 'desktopCompanion', ...live };
      const signature = JSON.stringify(message);
      if (signature === previous) return;
      if (state.character !== 'off' || previous) post(message);
      previous = state.character === 'off' ? '' : signature;
    });
  }
  function syncTasks(connected) {
    const live = new Map();
    for (const row of connected ? activities : []) {
      const turn = turns.get(row.threadId);
      if (terminal.has(row.turnId) || (turn && turn !== row.turnId)) continue;
      live.set(row.threadId,row);
    }
    let phase = 'work', agents = connected ? backgroundAgents : 0;
    const taskNames = [];
    for (const row of live.values()) {
      if (row.phase==='command' || (phase==='work' && row.phase==='thinking')) phase=row.phase;
      if (Number.isSafeInteger(row.agents) && row.agents>0) agents+=row.agents;
      const title = names.get(row.threadId) || row.name || '';
      const label = title.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,64).replace(/[\ud800-\udbff]$/,'');
      if(taskNames.length<32)taskNames.push(label || ('对话 '+row.threadId.slice(-8)));
    }
    update({connected,running:live.size,agents,taskNames,phase:agents?'team':phase});
  }
  return {
    appearance(character, {theme, reducedMotion}, size) {
      if (character==='off' && state.character!=='off') { activities=[]; backgroundAgents=0; syncTasks(state.connected); }
      update({character, size, dark: theme === 'dark', reducedMotion});
    },
    tasks(connected, titles, activeTurns, terminalTurns) {
      if (!post) return;
      names = titles; turns = activeTurns; terminal = terminalTurns;
      if (!connected) {activities = []; backgroundAgents=0;}
      syncTasks(connected);
    },
    activity(snapshot) {
      activities = state.connected && snapshot?.connected && Array.isArray(snapshot.running) ? snapshot.running : [];
      backgroundAgents = state.connected && snapshot?.connected && Number.isSafeInteger(snapshot.backgroundAgents) && snapshot.backgroundAgents>0 ? snapshot.backgroundAgents : 0;
      syncTasks(state.connected);
    },
    pending(questions, approvals) {
      if (questions !== state.questions || approvals !== state.approvals) update({questions, approvals});
    },
    quota: (windows, stale) => update({quota: windows.map(({minutes, remaining}) => ({minutes, remaining})), stale}),
  };
}
