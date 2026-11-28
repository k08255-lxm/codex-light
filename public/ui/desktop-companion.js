/** The floating window only needs counts and allowance, even for private conversations. */
export function createDesktopCompanion(post) {
  const state = { character: 'off', dark: false, reducedMotion: false, connected: false,
    running: 0, questions: 0, approvals: 0, quota: [], stale: false };
  let queued = false, previous = '';
  function update(change) {
    Object.assign(state, change);
    if (!post || queued || (state.character === 'off' && !previous)) return;
    queued = true;
    // Reconnection, account resets and turn events can update several sources in one tick.
    queueMicrotask(() => {
      queued = false;
      const live = state.connected ? state : { ...state, running: 0, questions: 0, approvals: 0, quota: [], stale: false };
      const message = state.character === 'off' ? { type: 'desktopCompanion', character: 'off' } : { type: 'desktopCompanion', ...live };
      const signature = JSON.stringify(message);
      if (signature === previous) return;
      if (state.character !== 'off' || previous) post(message);
      previous = state.character === 'off' ? '' : signature;
    });
  }
  return {
    appearance: (character, {theme, reducedMotion}) => update({character, dark: theme === 'dark', reducedMotion}),
    tasks(connected, running) {
      if (connected !== state.connected || running !== state.running) update({connected, running});
    },
    pending(questions, approvals) {
      if (questions !== state.questions || approvals !== state.approvals) update({questions, approvals});
    },
    quota: (windows, stale) => update({quota: windows.map(({minutes, remaining}) => ({minutes, remaining})), stale}),
  };
}
