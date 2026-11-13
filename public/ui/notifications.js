// One transient message at a time; dialogs requiring a decision use their own lifecycle.
export function createNotifications({targets, activeTarget, setTimer = setTimeout, clearTimer = clearTimeout}) {
  let timer = null;
  let revision = 0;
  function dismiss() {
    revision++;
    if (timer !== null) clearTimer(timer);
    timer = null;
    for (const target of targets) target.classList.add('hidden');
  }
  function show(text, error = false) {
    dismiss();
    const target = activeTarget();
    target.querySelector('span').textContent = String(text);
    target.classList.toggle('error', error);
    target.classList.remove('hidden');
    const current = revision;
    timer = setTimer(() => { if (current === revision) dismiss(); }, 5000);
  }
  return {show, dismiss};
}
