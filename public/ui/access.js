// Access token bootstrap. Runs before any network call.
// Also polyfills Web APIs gated on [SecureContext] (such as crypto.randomUUID and navigator.clipboard)
// when served over HTTP LAN, preserving standard Promise rejection on system copy failure.

export function createClipboardWriteText({ getWindow = () => (typeof window !== 'undefined' ? window : undefined), getDocument = () => (typeof document !== 'undefined' ? document : undefined) } = {}) {
  return async function writeText(text) {
    const value = String(text ?? '');
    const win = getWindow();
    if (win?.CodexLightNative && typeof win.CodexLightNative.copyToClipboard === 'function') {
      const copied = win.CodexLightNative.copyToClipboard(value);
      if (copied !== true) {
        throw new Error('Clipboard write failed');
      }
      return;
    }
    const doc = getDocument();
    if (!doc?.body || typeof doc.createElement !== 'function' || typeof doc.execCommand !== 'function') {
      throw new Error('Clipboard unavailable');
    }
    const ta = doc.createElement('textarea');
    ta.value = value;
    if (typeof ta.setAttribute === 'function') ta.setAttribute('readonly', '');
    if (ta.style) {
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
    }
    doc.body.appendChild(ta);
    let copied = false;
    try {
      if (typeof ta.focus === 'function') ta.focus({ preventScroll: true });
      if (typeof ta.select === 'function') ta.select();
      if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(0, value.length);
      copied = doc.execCommand('copy') === true;
    } finally {
      if (typeof ta.remove === 'function') ta.remove();
    }
    if (!copied) {
      throw new Error('Clipboard write failed');
    }
  };
}

(function ensureInsecureContextPolyfills() {
  const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
  try {
    if (typeof document !== 'undefined' && document.documentElement && typeof window !== 'undefined' && window.CodexLightNative?.isNativeApp?.()) {
      document.documentElement.dataset.mobileShell = 'android';
    }
  } catch {}
  const generateUUIDv4 = () => {
    const bytes = new Uint8Array(16);
    if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
      g.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'));
    return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
  };
  try {
    if (typeof Crypto !== 'undefined' && Crypto.prototype && typeof Crypto.prototype.randomUUID !== 'function') {
      Object.defineProperty(Crypto.prototype, 'randomUUID', { value: generateUUIDv4, configurable: true, writable: true });
    }
  } catch {}
  try {
    if (!g.crypto) g.crypto = {};
    if (typeof g.crypto.randomUUID !== 'function') {
      Object.defineProperty(g.crypto, 'randomUUID', { value: generateUUIDv4, configurable: true, writable: true });
    }
  } catch {}
  try {
    if (typeof navigator !== 'undefined' && (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function')) {
      const writeText = createClipboardWriteText();
      if (!navigator.clipboard) {
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      } else {
        navigator.clipboard.writeText = writeText;
      }
    }
  } catch {}
})();

// Loopback (this computer): the fragment token is kept in sessionStorage so a reload keeps working.
// LAN (any other hostname, e.g. a phone): the token lives in memory only. Nothing is written to
// session/local storage, and the fragment is removed from the address bar immediately.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export const TOKEN_KEY = 'codex-light-token';

export function isLoopbackHost(hostname) { return LOOPBACK.has(String(hostname || '').toLowerCase()); }

/**
 * @param {{hostname:string, hash:string, pathname:string, search:string}} location
 * @param {Storage|null} storage  sessionStorage (may throw)
 * @param {(url:string)=>void} replaceUrl  history.replaceState wrapper
 * @returns {{token:string|null, lan:boolean, fromFragment:boolean}}
 */
export function bootstrapToken(location, storage, replaceUrl) {
  const lan = !isLoopbackHost(location.hostname);
  let nativeToken = null;
  try { nativeToken = (typeof window !== 'undefined' && window.CodexLightNative?.getToken) ? window.CodexLightNative.getToken() : null; } catch {}
  const fromHash = new URLSearchParams(String(location.hash || '').slice(1)).get('token') || nativeToken;
  // Clear the fragment first so the secret does not linger in the visible URL or history entry.
  if (location.hash) replaceUrl(location.pathname + location.search);
  if (lan) {
    // Remove any value a previous build may have stored; never read it back.
    try { storage?.removeItem(TOKEN_KEY); } catch {}
    return { token: fromHash || null, lan: true, fromFragment: !!fromHash };
  }
  let stored = null;
  try { stored = storage?.getItem(TOKEN_KEY) ?? null; } catch {}
  const token = fromHash || stored;
  if (fromHash) { try { storage?.setItem(TOKEN_KEY, fromHash); } catch {} }
  return { token, lan: false, fromFragment: !!fromHash };
}
