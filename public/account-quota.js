import { el, localTime, relativeReset, windowLabel, UNKNOWN } from './ui/format.js';

/** Prefer the multi-bucket contract; the legacy view mirrors one of these buckets. */
export function quotaBuckets(result) {
  const map = result?.rateLimitsByLimitId;
  if (map && typeof map === 'object' && Object.keys(map).length) return Object.entries(map).filter(([, value]) => value && typeof value === 'object').map(([id, bucket]) => ({ ...bucket, id }));
  if (result?.rateLimits && typeof result.rateLimits === 'object') return [{ ...result.rateLimits, id: result.rateLimits.limitId || 'default' }];
  return [];
}

export function windowView(window, now = Date.now()) {
  if (!window || typeof window !== 'object') return null;
  const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? Math.min(100, Math.max(0, window.usedPercent)) : null;
  return { used, remaining: used === null ? null : 100 - used, label: windowLabel(window.windowDurationMins), reset: relativeReset(window.resetsAt, now), resetAt: typeof window.resetsAt === 'number' ? localTime(window.resetsAt * 1000) : UNKNOWN };
}

/** One relevant bucket only. An ambiguous collection must not become a fake combined quota. */
export function sidebarQuotaWindows(result) {
  const buckets = quotaBuckets(result);
  const bucket = buckets.find(item => item.id === 'codex' || item.limitId === 'codex') || (buckets.length === 1 ? buckets[0] : null);
  if (!bucket) return [];
  return ['primary', 'secondary'].map(key => bucket[key]).filter(window => {
    const mins = window?.windowDurationMins;
    return Number.isFinite(window?.usedPercent) && (mins === 10080 || (Number.isInteger(mins) && mins >= 60 && mins < 1440 && mins % 60 === 0));
  }).map(window => ({ ...windowView(window), shortLabel: window.windowDurationMins === 10080 ? '周' : `${window.windowDurationMins / 60}h`, bucket: bucket.limitName || bucket.id }));
}

/** Start/stop are driven by connection state. Background reads never fetch credit details. */
export function mountAccountQuota(host, { rpc, onOpen = () => {}, pollMs = 300000 }) {
  const document = host.ownerDocument;
  let epoch = 0, active = false, timer = null, inFlight = null, snapshot = null;
  host.classList.add('account-quota-mini'); host.hidden = true;
  function update(result) {
    snapshot = result;
    const windows = sidebarQuotaWindows(result);
    host.replaceChildren(); host.hidden = !windows.length;
    if (!windows.length) return;
    const button = el(document, 'button', 'account-quota-open'); button.type = 'button';
    button.setAttribute('aria-label', `查看账户额度。${windows.map(view => `${view.label}已用 ${Math.round(view.used)}%，${view.reset}`).join('；')}`);
    button.title = windows.map(view => `${view.bucket} · ${view.label} · 已用 ${Math.round(view.used)}% · ${view.reset}（${view.resetAt}）`).join('\n');
    button.addEventListener('click', onOpen);
    for (const view of windows) {
      const row = el(document, 'span', 'account-quota-row');
      row.title = `${view.bucket} · ${view.label} · 已用 ${Math.round(view.used)}% · ${view.reset}（${view.resetAt}）`;
      const label = el(document, 'span', 'account-quota-label', view.shortLabel); label.setAttribute('aria-hidden', 'true');
      const track = el(document, 'span', 'account-quota-track'); track.setAttribute('role', 'meter'); track.setAttribute('aria-label', `${view.label}使用比例`); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); track.setAttribute('aria-valuenow', String(view.used));
      track.dataset.level = view.used >= 90 ? 'high' : view.used >= 70 ? 'mid' : 'low';
      const fill = el(document, 'span'); fill.style.width = `${view.used}%`; track.append(fill); row.append(label, track); button.append(row);
    }
    host.append(button);
  }
  async function refresh() {
    if (!active) return;
    if (inFlight) return inFlight;
    const mine = epoch;
    const task = (async () => {
      try { const result = await rpc('account/rateLimits/read', { excludeResetCreditDetails: true }); if (active && mine === epoch) update(result); }
      catch { if (mine === epoch) { host.hidden = true; host.replaceChildren(); } }
      finally { if (mine === epoch) inFlight = null; }
    })();
    inFlight = task; return task;
  }
  function reset() { epoch++; inFlight = null; snapshot = null; host.hidden = true; host.replaceChildren(); }
  function stop() { active = false; clearInterval(timer); timer = null; reset(); }
  function start() { if (active) return; active = true; refresh(); timer = setInterval(refresh, Math.max(120000, pollMs)); }
  function handleEvent(message) {
    if (message.method === 'account/rateLimits/updated') {
      if (active) {
        // This notification is sparse, unlike the read response. Merge only supplied values.
        const patch = message.params?.rateLimits;
        if (!patch || typeof patch !== 'object') return true;
        const buckets = quotaBuckets(snapshot);
        const prior = patch?.limitId ? buckets.find(bucket => bucket.id === patch.limitId || bucket.limitId === patch.limitId) : buckets.length === 1 ? buckets[0] : null;
        if (!prior) refresh();
        else {
          const merge = (old, next) => Object.fromEntries([...Object.entries(old || {}), ...Object.entries(next || {}).filter(([, value]) => value != null)]);
          const merged = merge(prior, patch);
          for (const key of ['primary', 'secondary']) if (patch[key]) merged[key] = merge(prior[key], patch[key]);
          if (snapshot?.rateLimitsByLimitId && Object.keys(snapshot.rateLimitsByLimitId).length) update({ ...snapshot, rateLimitsByLimitId: { ...snapshot.rateLimitsByLimitId, [prior.id]: merged } });
          else update({ ...snapshot, rateLimits: merged });
        }
      }
      return true;
    }
    if (message.method === 'account/updated') { reset(); if (active) refresh(); return true; }
    return false;
  }
  return { start, stop, refresh, reset, update, handleEvent };
}
