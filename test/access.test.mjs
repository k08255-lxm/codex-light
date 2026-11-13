import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapToken, createClipboardWriteText, isLoopbackHost, TOKEN_KEY } from '../public/ui/access.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key)
  };
}

test('isLoopbackHost recognizes only localhost and loopback literals', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('192.168.31.192'), false);
  assert.equal(isLoopbackHost('10.0.0.5'), false);
});

test('loopback bootstrap stores fragment token in sessionStorage and strips hash', () => {
  const storage = memoryStorage();
  let replaced = null;
  const result = bootstrapToken(
    { hostname: '127.0.0.1', pathname: '/', search: '', hash: '#token=abc123' },
    storage,
    url => { replaced = url; }
  );
  assert.deepEqual(result, { token: 'abc123', lan: false, fromFragment: true });
  assert.equal(replaced, '/');
  assert.equal(storage.getItem(TOKEN_KEY), 'abc123');
});

test('LAN bootstrap clears fragment, purges storage, and falls back to CodexLightNative bridge on reload', () => {
  const storage = memoryStorage({ [TOKEN_KEY]: 'stale-secret' });
  let replaced = null;
  const prevWindow = globalThis.window;
  try {
    globalThis.window = { CodexLightNative: { getToken: () => 'native-lan-token' } };
    const initial = bootstrapToken(
      { hostname: '192.168.31.192', pathname: '/', search: '', hash: '#token=hash-lan-token' },
      storage,
      url => { replaced = url; }
    );
    assert.deepEqual(initial, { token: 'hash-lan-token', lan: true, fromFragment: true });
    assert.equal(replaced, '/');
    assert.equal(storage.getItem(TOKEN_KEY), null);

    const reloaded = bootstrapToken(
      { hostname: '192.168.31.192', pathname: '/', search: '', hash: '' },
      storage,
      () => {}
    );
    assert.deepEqual(reloaded, { token: 'native-lan-token', lan: true, fromFragment: true });
    assert.equal(storage.getItem(TOKEN_KEY), null);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test('crypto.randomUUID remains available and conforms to RFC 4122 v4', () => {
  assert.equal(typeof globalThis.crypto?.randomUUID, 'function');
  const seen = new Set();
  for (let i = 0; i < 32; i++) {
    const id = globalThis.crypto.randomUUID();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 32);
});

test('HTTP clipboard fallback resolves undefined on success and rejects when execCommand or native copy fails', async () => {
  let appended = 0;
  let removed = 0;
  let execResult = true;
  let execThrow = false;
  const fakeDoc = {
    body: { appendChild() { appended++; } },
    createElement() {
      return {
        value: '',
        style: {},
        setAttribute() {},
        focus() {},
        select() {},
        setSelectionRange() {},
        remove() { removed++; }
      };
    },
    execCommand(cmd) {
      assert.equal(cmd, 'copy');
      if (execThrow) throw new Error('blocked');
      return execResult;
    }
  };

  const domWrite = createClipboardWriteText({ getWindow: () => ({}), getDocument: () => fakeDoc });
  assert.equal(await domWrite('hello'), undefined);
  assert.equal(appended, 1);
  assert.equal(removed, 1);

  execResult = false;
  await assert.rejects(() => domWrite('hello'), /Clipboard write failed/);
  assert.equal(removed, 2);

  execThrow = true;
  await assert.rejects(() => domWrite('hello'), /blocked/);
  assert.equal(removed, 3);

  const missingDocWrite = createClipboardWriteText({ getWindow: () => ({}), getDocument: () => ({}) });
  await assert.rejects(() => missingDocWrite('hello'), /Clipboard unavailable/);

  let nativeResult = true;
  const nativeWrite = createClipboardWriteText({
    getWindow: () => ({ CodexLightNative: { copyToClipboard: () => nativeResult } }),
    getDocument: () => fakeDoc
  });
  assert.equal(await nativeWrite('secret'), undefined);

  nativeResult = false;
  await assert.rejects(() => nativeWrite('secret'), /Clipboard write failed/);
});
