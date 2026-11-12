/**
 * account-login-state.mjs
 *
 * A dependency-free, in-memory state machine for one account-login attempt.
 * It records only the lifecycle of a login attempt. It does not authenticate,
 * contact a provider, persist anything, or prove that a real login succeeded.
 *
 * Public API:
 *   const login = createLoginState();
 *   login.begin(loginId)
 *   login.complete({ loginId, success, error })
 *   login.cancel(loginId)
 *   login.reset()
 *   login.snapshot()
 *
 * Every successful mutator and snapshot() returns a new frozen snapshot:
 *   { status, loginId, error, revision }
 *
 * Security properties:
 *   - A loginId can be used only once per createLoginState() instance, ever.
 *   - reset() clears current state but never clears the used-ID history.
 *   - At most 1024 distinct IDs are remembered; the history is never evicted.
 *   - Failed attempts expose only the fixed message "登录失败". The original
 *     service error is never retained, inspected for secrets, or returned.
 */

export const LOGIN_ID_MAX_LENGTH = 128;
export const MAX_DISTINCT_LOGIN_IDS = 1024;

export const LOGIN_STATES = Object.freeze([
  'idle',
  'pending',
  'succeeded',
  'failed',
  'canceled',
]);

/** Fixed display text for every failed attempt. */
const LOGIN_FAILED_MESSAGE = '登录失败';

/** Strict, case-sensitive, ASCII-only login identifier. */
const LOGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:@-]{0,127}$/;

const COMPLETE_FIELDS = new Set(['loginId', 'success', 'error']);

/**
 * Error thrown for invalid arguments and invalid state transitions.
 * `code` is a stable, machine-readable string. Messages are static and never
 * contain the supplied loginId, error text, or any other input value.
 */
export class LoginStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LoginStateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LoginStateError(code, message);
}

function validateLoginId(loginId) {
  if (typeof loginId !== 'string' || !LOGIN_ID_PATTERN.test(loginId)) {
    fail(
      'EINVALID_ARGUMENT',
      'loginId must be a 1-128 character ASCII identifier matching ' +
        '/^[A-Za-z0-9][A-Za-z0-9._+:@-]*$/.',
    );
  }
}

/**
 * Read complete()'s input without invoking getters and without retaining the
 * input object. Only own, enumerable, data properties are accepted. The field
 * set is closed: anything besides loginId, success, and error is rejected.
 *
 * The error property is accepted only as a string, null, or undefined for API
 * compatibility. Its content is deliberately ignored: it is never stored,
 * sanitized, scanned, or returned. Failure snapshots always use the fixed
 * generic message.
 *
 * @param {unknown} input
 * @returns {{loginId: string, success: boolean}}
 */
function readCompleteInput(input) {
  if (input === null || typeof input !== 'object') {
    fail('EINVALID_ARGUMENT', 'complete() requires a plain object.');
  }

  let proto;
  let descriptors;
  try {
    proto = Object.getPrototypeOf(input);
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    fail('EINVALID_ARGUMENT', 'complete() requires a plain object.');
  }

  if (proto !== Object.prototype && proto !== null) {
    fail('EINVALID_ARGUMENT', 'complete() requires a plain object.');
  }

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !COMPLETE_FIELDS.has(key)) {
      fail('EUNKNOWN_FIELD', 'complete() input contains an unsupported field.');
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(
        'EINVALID_ARGUMENT',
        'complete() input must use enumerable data properties.',
      );
    }
  }

  if (!Object.hasOwn(descriptors, 'loginId')) {
    fail('EINVALID_ARGUMENT', 'complete() requires an own loginId property.');
  }
  if (!Object.hasOwn(descriptors, 'success')) {
    fail('EINVALID_ARGUMENT', 'complete() requires an own success property.');
  }

  const loginId = descriptors.loginId.value;
  const success = descriptors.success.value;
  const hasError = Object.hasOwn(descriptors, 'error');
  const rawError = hasError ? descriptors.error.value : undefined;

  validateLoginId(loginId);

  if (typeof success !== 'boolean') {
    fail('EINVALID_ARGUMENT', 'success must be a boolean.');
  }

  if (success) {
    if (hasError && rawError !== undefined && rawError !== null) {
      fail(
        'EINVALID_ARGUMENT',
        'error must be omitted or null when success is true.',
      );
    }
    return { loginId, success: true };
  }

  if (
    hasError &&
    rawError !== undefined &&
    rawError !== null &&
    typeof rawError !== 'string'
  ) {
    fail(
      'EINVALID_ARGUMENT',
      'error must be a string, null, or undefined when provided.',
    );
  }

  return { loginId, success: false };
}

/**
 * Create an independent login-state machine.
 *
 * @returns {Readonly<{
 *   begin: (loginId: string) => Readonly<LoginSnapshot>,
 *   complete: (input: {loginId: string, success: boolean, error?: string|null}) => Readonly<LoginSnapshot>,
 *   cancel: (loginId: string) => Readonly<LoginSnapshot>,
 *   reset: () => Readonly<LoginSnapshot>,
 *   snapshot: () => Readonly<LoginSnapshot>
 * }>}
 */
export function createLoginState() {
  /** @type {{status: string, loginId: string|null, error: string|null, revision: number}} */
  let state = Object.freeze({
    status: 'idle',
    loginId: null,
    error: null,
    revision: 0,
  });

  /**
   * Every distinct loginId ever accepted by begin() for this instance.
   * reset() and terminal transitions intentionally do not clear it.
   * @type {Set<string>}
   */
  const usedLoginIds = new Set();

  function snapshot(...extra) {
    if (extra.length > 0) {
      fail('EINVALID_ARGUMENT', 'snapshot() accepts no arguments.');
    }
    return Object.freeze({
      status: state.status,
      loginId: state.loginId,
      error: state.error,
      revision: state.revision,
    });
  }

  function begin(loginId, ...extra) {
    if (extra.length > 0) {
      fail('EINVALID_ARGUMENT', 'begin() accepts exactly one argument.');
    }
    validateLoginId(loginId);

    if (usedLoginIds.has(loginId)) {
      throw new TypeError(
        'loginId was already used in this login state instance; IDs cannot be reused.',
      );
    }

    if (usedLoginIds.size >= MAX_DISTINCT_LOGIN_IDS) {
      fail(
        'ELOGIN_ID_LIMIT',
        `Login ID history is full (${MAX_DISTINCT_LOGIN_IDS} distinct IDs); create a new instance.`,
      );
    }

    if (state.status === 'pending') {
      fail('ELOGIN_PENDING', 'A login is already pending.');
    }

    usedLoginIds.add(loginId);
    state = Object.freeze({
      status: 'pending',
      loginId,
      error: null,
      revision: state.revision + 1,
    });
    return snapshot();
  }

  /**
   * Ensure `loginId` owns the current non-idle state and that the operation is
   * still legal for that state.
   */
  function assertOwned(loginId, operation) {
    if (state.status === 'idle') {
      fail('ENO_ACTIVE_LOGIN', `No login is active for ${operation}().`);
    }
    if (state.loginId !== loginId) {
      fail('ESTALE_LOGIN', 'loginId does not own the current login state.');
    }
    if (state.status === 'succeeded' || state.status === 'failed') {
      fail('EALREADY_COMPLETED', 'This login has already completed.');
    }
    if (state.status === 'canceled') {
      fail('ECANCELED', 'This login was canceled.');
    }
  }

  function complete(input, ...extra) {
    if (extra.length > 0) {
      fail('EINVALID_ARGUMENT', 'complete() accepts exactly one argument.');
    }

    const { loginId, success } = readCompleteInput(input);
    assertOwned(loginId, 'complete');

    state = Object.freeze({
      status: success ? 'succeeded' : 'failed',
      loginId,
      error: success ? null : LOGIN_FAILED_MESSAGE,
      revision: state.revision + 1,
    });
    return snapshot();
  }

  function cancel(loginId, ...extra) {
    if (extra.length > 0) {
      fail('EINVALID_ARGUMENT', 'cancel() accepts exactly one argument.');
    }
    validateLoginId(loginId);
    assertOwned(loginId, 'cancel');

    state = Object.freeze({
      status: 'canceled',
      loginId,
      error: null,
      revision: state.revision + 1,
    });
    return snapshot();
  }

  function reset(...extra) {
    if (extra.length > 0) {
      fail('EINVALID_ARGUMENT', 'reset() accepts no arguments.');
    }

    if (state.status !== 'idle') {
      state = Object.freeze({
        status: 'idle',
        loginId: null,
        error: null,
        revision: state.revision + 1,
      });
    }
    return snapshot();
  }

  return Object.freeze({ begin, complete, cancel, reset, snapshot });
}

export default createLoginState;
