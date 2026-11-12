import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLoginState,
  LoginStateError,
  LOGIN_ID_MAX_LENGTH,
  MAX_DISTINCT_LOGIN_IDS,
  LOGIN_STATES,
} from '../src/account-login-state.mjs';

const GENERIC_FAILURE = '登录失败';
const snap = (status, loginId, revision, error = null) => ({status, loginId, error, revision});

function capture(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('Expected the function to throw, but it returned normally.');
}

function expectCode(fn, code) {
  const error = capture(fn);
  assert.ok(error instanceof LoginStateError, `expected LoginStateError, got ${error}`);
  assert.equal(error.name, 'LoginStateError');
  assert.equal(error.code, code);
  return error;
}

const expectInvalid = fn => expectCode(fn, 'EINVALID_ARGUMENT');

function expectReuseTypeError(login, loginId) {
  const before = login.snapshot();
  const error = capture(() => login.begin(loginId));
  assert.ok(error instanceof TypeError && !(error instanceof LoginStateError), `expected plain TypeError, got ${error}`);
  assert.equal(error.name, 'TypeError');
  assert.deepEqual(login.snapshot(), before);
}

// deepEqual on the exact four-field record also proves no service text, URL or credential is retained.
function expectSnapshot(snapshot, expected) {
  assert.deepEqual(snapshot, expected);
  assert.ok(Object.isFrozen(snapshot));
}

/** Drive a fresh machine with `id` into the named state. */
function inState(status, id = 'login-a') {
  const login = createLoginState();
  if (status === 'idle') return login;
  login.begin(id);
  if (status === 'succeeded') login.complete({loginId: id, success: true});
  if (status === 'failed') login.complete({loginId: id, success: false, error: 'service text'});
  if (status === 'canceled') login.cancel(id);
  return login;
}

test('snapshots are fresh frozen copies of exactly four fields', () => {
  const login = createLoginState();
  const idle = login.snapshot();
  expectSnapshot(idle, snap('idle', null, 0));
  assert.notStrictEqual(login.snapshot(), idle);
  assert.ok(Object.isFrozen(login));
  assert.ok(Object.isFrozen(LOGIN_STATES));
  assert.deepEqual([...LOGIN_STATES], ['idle', 'pending', 'succeeded', 'failed', 'canceled']);

  expectSnapshot(login.begin('User-1'), snap('pending', 'User-1', 1));
  const pending = login.snapshot();
  for (const [field, value] of [['status', 'succeeded'], ['loginId', 'other'], ['error', 'changed'], ['revision', 99]]) {
    assert.throws(() => { pending[field] = value; }, TypeError, field);
  }
  assert.deepEqual(login.snapshot(), pending);
});

test('begin accepts the documented identifier boundary and character set', () => {
  for (const loginId of ['a', 'A1', 'user.name+tag@example.com', 'x:y_z-9', 'a'.repeat(LOGIN_ID_MAX_LENGTH)]) {
    expectSnapshot(createLoginState().begin(loginId), snap('pending', loginId, 1));
  }
});

test('begin rejects malformed identifiers without changing state', () => {
  const login = createLoginState();
  const before = login.snapshot();
  const invalidIds = [
    undefined, null, 0, 1, 1n, true, [], {}, '', ' ', ' abc', 'abc ', 'a b', 'a\nb', 'a\tb',
    '-abc', '.abc', '_abc', '@abc', 'é', 'abc/def', 'a'.repeat(LOGIN_ID_MAX_LENGTH + 1),
    new String('abc'), Symbol('abc'), () => 'abc',
  ];
  for (const loginId of invalidIds) {
    expectInvalid(() => login.begin(loginId));
    assert.deepEqual(login.snapshot(), before);
  }
});

test('a pending login blocks a new begin and its own ID is a reuse TypeError', () => {
  const login = inState('pending', 'first');
  const before = login.snapshot();
  expectReuseTypeError(login, 'first');
  expectCode(() => login.begin('second'), 'ELOGIN_PENDING');
  assert.deepEqual(login.snapshot(), before);
});

test('complete records success or the generic failure; error may be omitted, undefined or null', () => {
  for (const success of [true, false]) {
    for (const extra of [{}, {error: undefined}, {error: null}, ...(success ? [] : [{error: 'Invalid credentials'}])]) {
      const login = inState('pending');
      const snapshot = login.complete({loginId: 'login-a', success, ...extra});
      expectSnapshot(snapshot, success ? snap('succeeded', 'login-a', 2) : snap('failed', 'login-a', 2, GENERIC_FAILURE));
    }
  }
});

test('failure never stores service text, URLs, credentials, control characters or huge strings', () => {
  const serviceErrors = [
    'https://provider.example/device?user_code=ABC-123 token=tok_live_secret password=hunter2',
    '', '   ', '\u0000\u001b[31m\u007f\u0085\u202e', 'x'.repeat(10_000),
  ];
  for (const error of serviceErrors) {
    const login = inState('pending');
    expectSnapshot(login.complete({loginId: 'login-a', success: false, error}), snap('failed', 'login-a', 2, GENERIC_FAILURE));
  }
});

test('complete rejects malformed arguments and records nothing', () => {
  class FakeLoginInput {
    constructor() {
      this.loginId = 'login-a';
      this.success = true;
    }
  }
  const login = inState('pending');
  const before = login.snapshot();
  const ok = {loginId: 'login-a', success: true};
  const malformed = [
    undefined, null, 42, 'login-a', [], [ok], new Date(), new FakeLoginInput(), Object.create(ok),
    {}, {success: true}, {loginId: 'login-a'}, {loginId: 7, success: true},
    {...ok, success: 'true'}, {...ok, success: 1}, {...ok, success: new Boolean(true)},
    {...ok, error: 'unexpected'}, {...ok, error: ''},
    ...[500, new String('bad'), [], {}, Symbol('bad')].map(error => ({loginId: 'login-a', success: false, error})),
  ];
  for (const input of malformed) {
    expectInvalid(() => login.complete(input));
    assert.deepEqual(login.snapshot(), before);
  }
  const {proxy, revoke} = Proxy.revocable({}, {});
  revoke();
  expectInvalid(() => login.complete(proxy));
  assert.deepEqual(login.snapshot(), before);
});

test('complete rejects unknown fields, including credential-shaped ones, without echoing values', () => {
  const login = inState('pending');
  const before = login.snapshot();
  const unknownFields = {
    authUrl: 'https://example.test/device',
    userCode: 'USER-CODE-123',
    token: 'tok_live_secret',
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    credentials: {user: 'u', password: 'p'},
    password: 'password-secret',
    extra: true,
  };
  for (const [field, value] of Object.entries(unknownFields)) {
    const error = expectCode(() => login.complete({loginId: 'login-a', success: true, [field]: value}), 'EUNKNOWN_FIELD');
    assert.ok(!error.message.includes(String(value)));
  }
  const protoPayload = JSON.parse('{"loginId":"login-a","success":true,"__proto__":{"polluted":true}}');
  expectCode(() => login.complete(protoPayload), 'EUNKNOWN_FIELD');
  assert.equal({}.polluted, undefined);
  assert.deepEqual(login.snapshot(), before);
});

test('complete rejects symbol keys, accessors and non-enumerable fields without invoking getters', () => {
  const login = inState('pending');
  const before = login.snapshot();
  expectCode(() => login.complete({loginId: 'login-a', success: true, [Symbol('hidden')]: 'value'}), 'EUNKNOWN_FIELD');

  let getterCalled = false;
  const accessor = Object.defineProperty({success: true}, 'loginId', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'login-a';
    },
  });
  const accessorError = expectInvalid(() => login.complete(accessor));
  assert.equal(getterCalled, false);
  assert.ok(!accessorError.message.includes('login-a'));

  expectInvalid(() => login.complete(Object.defineProperty({success: true}, 'loginId', {enumerable: false, value: 'login-a'})));
  expectCode(() => login.complete(Object.defineProperty({loginId: 'login-a', success: true}, 'token', {enumerable: false, value: 'secret'})), 'EUNKNOWN_FIELD');
  assert.deepEqual(login.snapshot(), before);
});

test('complete accepts a null-prototype record and does not retain the input object', () => {
  const login = inState('pending');
  const input = Object.assign(Object.create(null), {loginId: 'login-a', success: false, error: 'first message'});
  const snapshot = login.complete(input);
  Object.assign(input, {loginId: 'other', success: true, error: 'second message', token: 'secret'});
  expectSnapshot(snapshot, snap('failed', 'login-a', 2, GENERIC_FAILURE));
  assert.deepEqual(login.snapshot(), snapshot);
});

test('stale loginIds cannot complete or cancel a pending login', () => {
  const login = inState('pending', 'owner');
  const before = login.snapshot();
  expectCode(() => login.complete({loginId: 'intruder', success: true}), 'ESTALE_LOGIN');
  expectCode(() => login.cancel('intruder'), 'ESTALE_LOGIN');
  expectCode(() => login.complete({loginId: 'OWNER', success: true}), 'ESTALE_LOGIN');
  assert.deepEqual(login.snapshot(), before);
});

test('terminal states own their result: late complete/cancel are rejected by the owning code', () => {
  for (const [status, code] of [['failed', 'EALREADY_COMPLETED'], ['succeeded', 'EALREADY_COMPLETED'], ['canceled', 'ECANCELED']]) {
    const login = inState(status);
    const before = login.snapshot();
    expectCode(() => login.complete({loginId: 'login-a', success: true}), code);
    expectCode(() => login.complete({loginId: 'login-a', success: false}), code);
    expectCode(() => login.cancel('login-a'), code);
    expectCode(() => login.complete({loginId: 'other', success: true}), 'ESTALE_LOGIN');
    expectCode(() => login.cancel('other'), 'ESTALE_LOGIN');
    assert.deepEqual(login.snapshot(), before, status);
  }
  const login = inState('pending');
  expectSnapshot(login.cancel('login-a'), snap('canceled', 'login-a', 2));
});

test('idle state rejects complete and cancel', () => {
  const login = createLoginState();
  expectCode(() => login.complete({loginId: 'login-a', success: true}), 'ENO_ACTIVE_LOGIN');
  expectCode(() => login.cancel('login-a'), 'ENO_ACTIVE_LOGIN');
  assert.deepEqual(login.snapshot(), snap('idle', null, 0));
});

test('a new begin after any terminal state starts a clean attempt', () => {
  for (const status of ['succeeded', 'failed', 'canceled']) {
    expectSnapshot(inState(status, 'first').begin('second'), snap('pending', 'second', 3));
  }
});

test('reset returns to idle once per non-idle state and the old loginId cannot finish', () => {
  const idle = createLoginState();
  const before = idle.snapshot();
  const after = idle.reset();
  assert.deepEqual(after, before);
  assert.notStrictEqual(after, before);

  for (const [status, revision] of [['pending', 2], ['succeeded', 3], ['failed', 3], ['canceled', 3]]) {
    const login = inState(status);
    expectSnapshot(login.reset(), snap('idle', null, revision));
    expectCode(() => login.complete({loginId: 'login-a', success: true}), 'ENO_ACTIVE_LOGIN');
    expectCode(() => login.cancel('login-a'), 'ENO_ACTIVE_LOGIN');
  }
});

test('all methods reject surplus arguments', () => {
  const login = inState('pending');
  const before = login.snapshot();
  expectInvalid(() => login.begin('other', 'extra'));
  expectInvalid(() => login.complete({loginId: 'login-a', success: true}, 'extra'));
  expectInvalid(() => login.cancel('login-a', 'extra'));
  expectInvalid(() => login.reset('extra'));
  expectInvalid(() => login.snapshot('extra'));
  assert.deepEqual(login.snapshot(), before);
});

test('a used ID can never be reused after reset or any terminal state', () => {
  for (const status of ['succeeded', 'failed', 'canceled', 'reset']) {
    const login = inState(status === 'reset' ? 'pending' : status, 'used-id');
    if (status === 'reset') login.reset();
    expectReuseTypeError(login, 'used-id');
  }
});

test('separate factories have independent state and ID history', () => {
  const first = createLoginState();
  const second = createLoginState();
  first.begin('login-a');
  second.begin('login-b');
  first.complete({loginId: 'login-a', success: true});
  assert.equal(first.snapshot().status, 'succeeded');
  assert.deepEqual(second.snapshot(), snap('pending', 'login-b', 1));

  first.reset();
  second.reset();
  expectReuseTypeError(first, 'login-a');
  expectReuseTypeError(second, 'login-b');
  assert.equal(first.begin('login-c').loginId, 'login-c');
  assert.equal(second.begin('login-d').loginId, 'login-d');
});

test('ID history is capped at 1024 distinct IDs without eviction', () => {
  const login = createLoginState();
  for (let index = 0; index < MAX_DISTINCT_LOGIN_IDS; index += 1) {
    login.begin(`id-${index}`);
    login.cancel(`id-${index}`);
  }
  const before = login.snapshot();
  assert.match(expectCode(() => login.begin('id-1024'), 'ELOGIN_ID_LIMIT').message, /new instance/i);
  assert.deepEqual(login.snapshot(), before);
  for (const oldId of ['id-0', 'id-512', 'id-1023']) expectReuseTypeError(login, oldId);

  login.reset();
  expectCode(() => login.begin('id-1024'), 'ELOGIN_ID_LIMIT');
  expectReuseTypeError(login, 'id-0');
  assert.equal(createLoginState().begin('id-1024').loginId, 'id-1024');
});
