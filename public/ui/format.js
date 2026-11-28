// Display formatting shared by the analytics and account views. Unknown stays visibly unknown.
export const UNKNOWN = '—';
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function compact(value) {
  if (!finite(value)) return UNKNOWN;
  if (Math.abs(value)<1000) return String(Math.round(value));
  const million=Math.abs(value)>=1_000_000;
  const scaled=value/(million?1_000_000:1000);
  return (Math.abs(scaled)>=100?Math.round(scaled):Math.round(scaled*10)/10)+(million?'M':'k');
}
export function showTokens(node,value,{suffix='',unknown=UNKNOWN}={}) {
  node.textContent=finite(value)?compact(value)+suffix:unknown;
  node.title=finite(value)?integer(value)+' tokens':'';
}
export function integer(value) { return finite(value) ? Math.round(value).toLocaleString('zh-CN') : UNKNOWN; }
export function percent(fraction, digits = 1) { return finite(fraction) ? (fraction * 100).toFixed(digits).replace(/\.0$/, '') + '%' : UNKNOWN; }
export function usd(value) {
  if (!finite(value)) return UNKNOWN;
  if (value === 0) return '$0';
  return value < 0.01 ? '$'+Number(value.toPrecision(5)).toString() : '$'+value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:value<10?4:2});
}
export function seconds(ms) {
  if (!finite(ms)) return UNKNOWN;
  if (ms < 1000) return Math.round(ms) + 'ms';
  const s = ms / 1000; if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's';
  const m = Math.floor(s / 60); return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}
export function rate(value, unit) { return finite(value) ? `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}` : UNKNOWN; }
export function localTime(iso, { date = true, time = true, seconds = false } = {}) {
  if (typeof iso !== 'string' && !finite(iso)) return UNKNOWN;
  const d = new Date(finite(iso) ? iso : Date.parse(iso)); if (Number.isNaN(d.getTime())) return UNKNOWN;
  const pad = n => String(n).padStart(2, '0');
  const parts = [];
  if (date) parts.push(`${d.getMonth() + 1}/${d.getDate()}`);
  if (time) parts.push(`${pad(d.getHours())}:${pad(d.getMinutes())}`+(seconds?':'+pad(d.getSeconds()):''));
  return parts.join(' ');
}
export function relativeReset(unixSeconds, now = Date.now()) {
  if (!finite(unixSeconds)) return UNKNOWN;
  const ms = unixSeconds * 1000 - now;
  if (ms <= 0) return '已到重置时间';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60); if (hours < 48) return `${hours} 小时 ${minutes % 60} 分后重置`;
  return `${Math.round(hours / 24)} 天后重置`;
}
export function windowLabel(minutes) {
  if (!finite(minutes) || minutes <= 0) return '窗口未知';
  if (minutes % 10080 === 0) return `${minutes / 10080} 周窗口`;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天窗口`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
  return `${minutes} 分钟窗口`;
}
export function el(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function switchInput(document) {
  const input = el(document, 'input', 'switch');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  return input;
}

// Native disabled controls lose focus while a save or refresh is in flight.
export function onAsyncSwitchChange(input, update) {
  input.addEventListener('change', async () => {
    const document = input.ownerDocument;
    const hadFocus = document.activeElement === input;
    try {
      await update();
    } finally {
      if (hadFocus && document.activeElement === document.body && input.isConnected && !input.disabled)
        input.focus({ preventScroll: true });
    }
  });
}
