import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

// Exercise production routing, not a permissive static-file test server. Traverse
// transitive dependencies too: an entry import can succeed while its imports 404.
test('entry assets and transitive module/style imports are served by real HTTP routing', async t => {
  const app = await createServer({ demo: true });
  await app.started;
  t.after(() => app.close());
  const entry = await fetch(app.origin + '/');
  assert.equal(entry.status, 200);
  const html = await entry.text();
  const pending = [...html.matchAll(/(?:src|href)=["'](\/[^"'#]+)["']/g)].map(match => match[1]);
  const seen = new Set();
  while (pending.length) {
    const asset = pending.shift();
    if (seen.has(asset)) continue;
    seen.add(asset);
    const response = await fetch(app.origin + asset);
    assert.equal(response.status, 200, `Missing public asset: ${asset}`);
    const source = await response.text();
    const extension = new URL(asset, app.origin).pathname.split('.').at(-1);
    if (!['js', 'mjs', 'css'].includes(extension)) continue;
    assert.match(response.headers.get('content-type'), extension === 'css' ? /text\/css/ : /(?:text|application)\/javascript/, asset);
    const imports = extension === 'css'
      ? /@import\s+(?:url\(\s*)?["']([^"']+)["']/g
      : /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      const specifier = match[1];
      // Bare packages and absolute remote modules are not relative assets.
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
      const resolved = new URL(specifier, app.origin + asset);
      assert.equal(resolved.origin, app.origin, `Unexpected cross-origin local import in ${asset}`);
      pending.push(resolved.pathname + resolved.search);
    }
  }
  assert.ok(seen.has('/ui/optimistic-messages.js'), 'must traverse composer transitive imports');
  assert.ok(seen.has('/ui/update-indicator.js'), 'must include update indicator entry import');
  assert.ok(seen.has('/ui/back-navigation.js'), 'must include Android back handler');
  assert.ok(seen.has('/ui/history-auto-load.js'), 'must include history paging');
});
