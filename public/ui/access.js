// Access token bootstrap. Runs before any network call.
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
  const fromHash = new URLSearchParams(String(location.hash || '').slice(1)).get('token');
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
