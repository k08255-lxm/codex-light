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
  return ['primary', 'secondary'].map(key => ({ window: bucket[key], key })).filter(({ window }) => {
    const mins = window?.windowDurationMins;
    return Number.isFinite(window?.usedPercent) && (mins === 10080 || (Number.isInteger(mins) && mins >= 60 && mins < 1440 && mins % 60 === 0));
  }).map(({ window, key }) => ({ ...windowView(window), key: `${bucket.id}:${key}:${window.windowDurationMins}`, shortLabel: window.windowDurationMins === 10080 ? '周' : `${window.windowDurationMins / 60}h`, bucket: bucket.limitName || bucket.id }));
}

function quotaRing(document, view) {
  function svgNode(tag, attributes) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }
  const svg = svgNode('svg', { viewBox: '0 0 40 40', 'aria-hidden': 'true', class: 'account-quota-ring' });
  const circle = { cx: 20, cy: 20, r: 16, pathLength: 100, fill: 'none', 'stroke-width': 2.5, 'stroke-linecap': 'round', transform: 'rotate(135 20 20)' };
  // Both arcs share a 90-degree opening; the fill represents remaining allowance.
  const track = svgNode('circle', { ...circle, class: 'account-quota-ring-track', 'stroke-dasharray': '75 25' });
  const portion = view.remaining * .75;
  const fill = svgNode('circle', { ...circle, class: 'account-quota-ring-fill', 'stroke-dasharray': `${portion} ${100 - portion}` });
  if (portion === 0) fill.setAttribute('visibility', 'hidden');
  const value = svgNode('text', { x: 20, y: 23, 'text-anchor': 'middle', class: 'account-quota-value' });
  value.textContent = `${Math.round(view.remaining)}%`;
  const period = svgNode('text', { x: 20, y: 38, 'text-anchor': 'middle', class: 'account-quota-period' });
  period.textContent = view.shortLabel;
  svg.append(track, fill, value, period);
  return svg;
}

/** Start/stop are driven by connection state. Background reads never fetch credit details. */
export function mountAccountQuota(host, { rpc, onOpen = () => {}, pollMs = 300000 }) {
  const document = host.ownerDocument;
  let epoch = 0, active = false, timer = null, inFlight = null, snapshot = null;
  let button = null;
  const rows = new Map();
  host.classList.add('account-quota-mini'); host.hidden = true;
  function update(result) {
    snapshot = result;
    const windows = sidebarQuotaWindows(result);
    host.hidden = !windows.length;
    host.removeAttribute('data-stale');
    if (!windows.length) { host.replaceChildren(); button = null; rows.clear(); return; }
    if (!button) {
      button = el(document, 'button', 'account-quota-open'); button.type = 'button';
      button.addEventListener('click', onOpen); host.append(button);
    }
    button.setAttribute('aria-label', `查看账户额度。${windows.map(view => `${view.label}剩余 ${Math.round(view.remaining)}%，${view.reset}`).join('；')}`);
    button.title = windows.map(view => `${view.bucket} · ${view.label} · 剩余 ${Math.round(view.remaining)}% · ${view.reset}（${view.resetAt}）`).join('\n');
    const keys = new Set(windows.map(view => view.key));
    for (const [key, row] of rows) if (!keys.has(key)) { row.remove(); rows.delete(key); }
    for (const [index, view] of windows.entries()) {
      let row = rows.get(view.key);
      if (!row) { row = el(document, 'span', 'account-quota-row'); row.append(quotaRing(document, view)); rows.set(view.key, row); }
      row.title = `${view.bucket} · ${view.label} · 剩余 ${Math.round(view.remaining)}% · ${view.reset}（${view.resetAt}）`;
      row.setAttribute('role', 'meter'); row.setAttribute('aria-label', `${view.label}剩余额度`);
      row.setAttribute('aria-valuemin', '0'); row.setAttribute('aria-valuemax', '100'); row.setAttribute('aria-valuenow', String(view.remaining));
      row.setAttribute('aria-valuetext', `${view.label}剩余 ${Math.round(view.remaining)}%，${view.reset}`);
      row.dataset.level = view.remaining <= 10 ? 'high' : view.remaining <= 30 ? 'mid' : 'low';
      const portion = view.remaining * .75;
      const fill = row.querySelector('.account-quota-ring-fill');
      fill.setAttribute('stroke-dasharray', `${portion} ${100 - portion}`);
      if (portion === 0) fill.setAttribute('visibility', 'hidden'); else fill.removeAttribute('visibility');
      const value = row.querySelector('.account-quota-value');
      const text = `${Math.round(view.remaining)}%`;
      if (value.textContent !== text) value.textContent = text;
      if (button.children[index] !== row) button.insertBefore(row, button.children[index] || null);
    }
  }
  async function refresh() {
    if (!active) return;
    if (inFlight) return inFlight;
    const mine = epoch;
    const task = (async () => {
      try { const result = await rpc('account/rateLimits/read', { excludeResetCreditDetails: true }); if (active && mine === epoch) update(result); }
      catch { if (active && mine === epoch && button) {
        if (!host.getAttribute('data-stale')) button.setAttribute('aria-label', `${button.getAttribute('aria-label')}；刷新失败，显示上次读取结果`);
        host.setAttribute('data-stale', 'true'); button.title = '额度刷新失败，显示上次读取结果';
      } }
      finally { if (mine === epoch) inFlight = null; }
    })();
    inFlight = task; return task;
  }
  function reset() { epoch++; inFlight = null; snapshot = null; button = null; rows.clear(); host.hidden = true; host.replaceChildren(); host.removeAttribute('data-stale'); }
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
    // Account identity is coordinated by the app after account/read verification.
    return false;
  }
  return { start, stop, refresh, reset, update, handleEvent };
}
