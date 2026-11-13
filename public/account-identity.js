// account/updated describes auth mode and plan, not which account is signed in.
// Keep identity in memory only; never compare plans or read authentication secrets.
export function accountIdentityKey(result) {
  const account = result?.account;
  if (account?.type !== 'chatgpt') return null;
  const clean = value => typeof value === 'string' && value.trim() ? value.trim() : null;
  const accountId = clean(result.workspaceRouting?.chatgptAccountId);
  const email = clean(account.email)?.toLowerCase();
  if (!accountId && !email) return null;
  return JSON.stringify(accountId ? ['chatgpt', 'id', accountId] : ['chatgpt', 'email', email]);
}

export function createAccountIdentityController({ rpc, onChange, onSame = () => {}, onError = () => {} }) {
  let epoch = 0, identity = null, pendingRead = null, pendingCheck = null, revision = 0;
  const changed = () => { revision++; onChange(); };
  function read() {
    if (pendingRead) return pendingRead;
    const mine = epoch;
    const task = Promise.resolve().then(() => rpc('account/read', { refreshToken: false })).then(result => {
      if (mine !== epoch) return result;
      const previous = identity;
      identity = accountIdentityKey(result);
      // A reset may immediately start the next page read; do not hand it the old request.
      if (pendingRead === task) pendingRead = null;
      if (previous && previous !== identity) changed();
      return result;
    }).finally(() => { if (pendingRead === task) pendingRead = null; });
    pendingRead = task;
    return task;
  }
  function verify() {
    if (pendingCheck) return pendingCheck;
    const mine = epoch, before = revision;
    const task = Promise.resolve().then(async () => {
      try {
        // Share an initial page read too: its successful identity is established before
        // classifying a notification emitted by that very same native account/read.
        const result = await read();
        if (mine !== epoch) return;
        if (!accountIdentityKey(result)) { if (revision === before) changed(); }
        else if (revision === before) await onSame(result);
      } catch (error) {
        if (mine !== epoch) return;
        identity = null;
        if (revision === before) changed();
        onError(error);
      }
    }).finally(() => { if (pendingCheck === task) pendingCheck = null; });
    pendingCheck = task;
    return task;
  }
  return {
    read, verify,
    reset() { epoch++; revision++; identity = null; pendingRead = null; pendingCheck = null; },
  };
}
