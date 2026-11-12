/**
 * update-manifest.mjs
 *
 * Pure validator for Windows x64 release update manifests.
 *
 * This module performs no I/O: it does not download, install, execute,
 * inspect the registry, resolve DNS, or open sockets. It only validates
 * plain data supplied by the caller.
 *
 * Public API:
 *   validateUpdateManifest(input, { trustedHosts }) -> frozen manifest
 *   compareVersions(a, b)                           -> -1 | 0 | 1
 *   planUpdate(current, manifest, { trustedHosts }) -> { status, manifest }
 */

import { isIP } from 'node:net';

const MAX_ARTIFACT_SIZE = 300 * 1024 * 1024; // 314_572_800 bytes
const MAX_VERSION_LENGTH = 256;
const MAX_HOSTNAME_LENGTH = 253;

const ALLOWED_FIELDS = Object.freeze([
  'version',
  'platform',
  'arch',
  'downloadUrl',
  'sha256',
  'size',
  'publishedAt',
]);
const FIELD_SET = new Set(ALLOWED_FIELDS);

// One DNS label: 1-63 chars, alphanumeric at both ends, hyphens inside.
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);

// SemVer 2.0.0, deliberately without the optional build-metadata suffix.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

// Strict UTC ISO-8601: YYYY-MM-DDTHH:mm:ss[.s{1,3}]Z
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/** Error thrown for every rejected manifest, option, or version. */
class ManifestValidationError extends TypeError {
  constructor(field, message) {
    super(`[update-manifest] ${field}: ${message}`);
    this.name = 'ManifestValidationError';
    this.code = 'ERR_INVALID_UPDATE_MANIFEST';
    this.field = field;
  }
}

function fail(field, message) {
  throw new ManifestValidationError(field, message);
}

function isDataDescriptor(descriptor) {
  return (
    descriptor !== undefined &&
    Object.hasOwn(descriptor, 'value') &&
    !Object.hasOwn(descriptor, 'get') &&
    !Object.hasOwn(descriptor, 'set')
  );
}

/**
 * Take a descriptor snapshot of a plain record before reading any value.
 * The prototype check is intentionally strict; callers pass JSON-shaped
 * records, not class instances or other executable objects.
 */
function getPlainRecordDescriptors(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, 'must be a plain object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(field, 'must be a plain object (prototype must be Object.prototype or null)');
  }
  return Object.getOwnPropertyDescriptors(value);
}

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

/**
 * Parse a strict SemVer 2.0.0 string. Numeric identifiers are kept as
 * strings so arbitrarily large values compare exactly (no Number rounding).
 */
function parseVersion(value, field) {
  if (typeof value !== 'string') fail(field, 'must be a string');
  if (value.length === 0) fail(field, 'must not be empty');
  if (value.length > MAX_VERSION_LENGTH) {
    fail(field, `must be at most ${MAX_VERSION_LENGTH} characters`);
  }
  if (value.includes('+')) {
    fail(field, 'build metadata ("+...") is not supported');
  }
  const match = SEMVER_RE.exec(value);
  if (!match) {
    fail(
      field,
      'must be a strict SemVer 2.0.0 version "MAJOR.MINOR.PATCH[-PRERELEASE]" without build metadata',
    );
  }
  return {
    raw: value,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/** Compare two canonical non-negative integer strings without Number coercion. */
function compareNumeric(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** SemVer 2.0.0 prerelease precedence rules. */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // release > prerelease
  if (b.length === 0) return -1;

  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const left = a[i];
    const right = b[i];
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);

    if (leftNumeric && rightNumeric) {
      const order = compareNumeric(left, right);
      if (order !== 0) return order;
    } else if (leftNumeric) {
      return -1; // numeric identifiers sort before alphanumeric ones
    } else if (rightNumeric) {
      return 1;
    } else if (left !== right) {
      return left < right ? -1 : 1; // ASCII lexical order
    }
  }

  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function compareParsed(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    const order = compareNumeric(a[key], b[key]);
    if (order !== 0) return order;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Compare two strict SemVer versions, including prerelease precedence.
 * @returns {-1|0|1} -1 when a < b, 0 when equal, 1 when a > b.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a, 'a');
  const right = parseVersion(b, 'b');
  return compareParsed(left, right);
}

/* ------------------------------------------------------------------ */
/* Individual fields                                                   */
/* ------------------------------------------------------------------ */

function isArrayIndexKey(key) {
  if (typeof key !== 'string' || key === '') return false;
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < 2 ** 32 - 1 &&
    String(index) === key
  );
}

function assertTrustedHost(host, field) {
  if (typeof host !== 'string') fail(field, 'must be a string');
  if (host.length === 0 || host.length > MAX_HOSTNAME_LENGTH) {
    fail(field, `must be between 1 and ${MAX_HOSTNAME_LENGTH} characters`);
  }
  if (host !== host.toLowerCase()) fail(field, 'must be lowercase');
  if (host.trim() !== host) fail(field, 'must not contain surrounding whitespace');
  if (/[/:@*#\\]/.test(host)) {
    fail(field, 'must be a bare hostname without scheme, port, path, wildcard, or fragment');
  }
  if (host.endsWith('.')) fail(field, 'must not end with a dot');
  if (isIP(host) !== 0) fail(field, 'IP addresses are not allowed');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    fail(field, 'localhost is not allowed');
  }
  if (!HOSTNAME_RE.test(host)) fail(field, 'must be a valid DNS hostname');
  if (/^\d+$/.test(host.split('.').at(-1))) {
    fail(field, 'numeric-only top-level labels are not allowed');
  }
}

/**
 * Read an ordinary dense array of hostname strings without invoking any
 * getter. Accessors, holes, array subclasses, symbol properties, extra
 * properties, and non-enumerable elements are rejected from descriptors.
 */
function readTrustedHostArray(value) {
  if (!Array.isArray(value)) {
    fail('trustedHosts', 'must be a non-empty array of hostnames');
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    fail('trustedHosts', 'must be an ordinary array (array subclasses are not supported)');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = [];
  let lengthDescriptor;

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') {
      fail('trustedHosts', 'symbol properties are not allowed');
    }
    const descriptor = descriptors[key];
    if (!isDataDescriptor(descriptor)) {
      fail('trustedHosts', `accessor property "${key}" is not allowed`);
    }
    if (key === 'length') {
      lengthDescriptor = descriptor;
      continue;
    }
    if (!isArrayIndexKey(key)) {
      fail('trustedHosts', `unexpected property "${key}" on the trustedHosts array`);
    }
    if (!descriptor.enumerable) {
      fail('trustedHosts', `element ${key} must be enumerable`);
    }
    entries.push({ index: Number(key), descriptor });
  }

  if (lengthDescriptor === undefined) {
    fail('trustedHosts', 'must be an ordinary array');
  }
  const length = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 2 ** 32 - 1) {
    fail('trustedHosts', 'has an invalid array length');
  }
  if (length === 0) fail('trustedHosts', 'must be a non-empty array of hostnames');
  if (entries.length !== length) {
    fail('trustedHosts', 'must be a dense array without holes');
  }

  entries.sort((a, b) => a.index - b.index);
  const hosts = new Set();
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].index !== i) {
      fail('trustedHosts', 'must be a dense array without holes');
    }
    // Read the snapshotted data value only; no property access on the array.
    const host = entries[i].descriptor.value;
    assertTrustedHost(host, `trustedHosts[${i}]`);
    hosts.add(host);
  }

  return hosts;
}

function normalizeTrustedHosts(options) {
  const descriptors = getPlainRecordDescriptors(options, 'options');

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail('options', 'symbol keys are not allowed');
    const descriptor = descriptors[key];
    if (!isDataDescriptor(descriptor)) {
      fail('options', `accessor property "${key}" is not allowed`);
    }
    if (!descriptor.enumerable) {
      fail('options', `property "${key}" must be enumerable`);
    }
    if (key !== 'trustedHosts') fail('options', `unknown option "${key}"`);
  }
  if (!Object.hasOwn(descriptors, 'trustedHosts')) {
    fail('options', 'a "trustedHosts" array is required');
  }

  return readTrustedHostArray(descriptors.trustedHosts.value);
}

function validateDownloadUrl(value, trustedHosts) {
  if (typeof value !== 'string') fail('downloadUrl', 'must be a string');
  if (value.length === 0) fail('downloadUrl', 'must not be empty');
  if (!/^[\x21-\x7E]+$/.test(value)) {
    fail(
      'downloadUrl',
      'must contain only printable ASCII characters (no spaces, control characters, or non-ASCII)',
    );
  }
  if (value.includes('#')) fail('downloadUrl', 'must not contain a fragment');
  if (value.includes('\\')) fail('downloadUrl', 'must not contain backslashes');

  let url;
  try {
    url = new URL(value);
  } catch {
    fail('downloadUrl', 'must be a valid absolute URL');
  }

  if (url.protocol !== 'https:') fail('downloadUrl', 'must use HTTPS');

  // Reject even empty userinfo (`https://@host/`), which the URL parser
  // otherwise normalizes to an empty username/password pair.
  const authority = value.slice(value.indexOf('://') + 3).split(/[/?]/, 1)[0];
  if (authority.includes('@') || url.username !== '' || url.password !== '') {
    fail('downloadUrl', 'must not contain userinfo credentials');
  }
  if (url.port !== '' && url.port !== '443') {
    fail('downloadUrl', 'must use port 443 or no explicit port');
  }

  const hostname = url.hostname;
  if (hostname.length === 0) fail('downloadUrl', 'must include a hostname');
  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    fail('downloadUrl', `hostname must be at most ${MAX_HOSTNAME_LENGTH} characters`);
  }
  if (hostname.endsWith('.')) fail('downloadUrl', 'hostname must not end with a dot');

  // IPv6 hostnames arrive wrapped in brackets.
  const bareHost =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (isIP(bareHost) !== 0) fail('downloadUrl', 'IP address hosts are not allowed');
  if (bareHost === 'localhost' || bareHost.endsWith('.localhost')) {
    fail('downloadUrl', 'localhost hosts are not allowed');
  }
  if (/^\d+$/.test(bareHost.split('.').at(-1))) {
    fail('downloadUrl', 'IP-like numeric hosts are not allowed');
  }
  if (!HOSTNAME_RE.test(bareHost)) fail('downloadUrl', 'hostname is not a valid DNS name');
  if (!trustedHosts.has(bareHost)) {
    fail('downloadUrl', `hostname "${bareHost}" is not in trustedHosts`);
  }

  return value;
}

function validateSha256(value) {
  if (typeof value !== 'string') fail('sha256', 'must be a string');
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    fail('sha256', 'must be exactly 64 hexadecimal characters');
  }
  return value.toLowerCase();
}

function validateSize(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail('size', 'must be a safe integer number of bytes');
  }
  if (value < 1 || value > MAX_ARTIFACT_SIZE) {
    fail('size', `must be between 1 and ${MAX_ARTIFACT_SIZE} bytes (300 MiB)`);
  }
  return value;
}

function validatePublishedAt(value) {
  if (typeof value !== 'string') fail('publishedAt', 'must be a string');
  const match = TIMESTAMP_RE.exec(value);
  if (!match) {
    fail(
      'publishedAt',
      'must be a strict UTC ISO-8601 timestamp "YYYY-MM-DDTHH:mm:ss[.sss]Z"',
    );
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction] = match;
  const year = Number(yearText);
  if (year < 1000) fail('publishedAt', 'year must be between 1000 and 9999');

  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = fraction === undefined ? 0 : Number(fraction.padEnd(3, '0'));

  // Round-trip through UTC to reject impossible calendar values
  // (Feb 30, month 13, hour 24, leap second 60, ...).
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) {
    fail('publishedAt', 'must be a real calendar timestamp');
  }

  return value;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Validate an untrusted update manifest and return a frozen copy containing
 * only the seven standard fields.
 *
 * @param {unknown} input
 * @param {{ trustedHosts: string[] }} options
 * @returns {Readonly<{
 *   version: string, platform: 'win32', arch: 'x64', downloadUrl: string,
 *   sha256: string, size: number, publishedAt: string
 * }>}
 */
export function validateUpdateManifest(input, options) {
  const trustedHosts = normalizeTrustedHosts(options);
  const descriptors = getPlainRecordDescriptors(input, 'input');

  // Inspect every own key (strings and symbols) and its descriptor before
  // reading a single value. This guarantees accessors are never invoked.
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail('input', 'symbol keys are not allowed');
    const descriptor = descriptors[key];
    if (!isDataDescriptor(descriptor)) {
      fail('input', `accessor property "${key}" is not allowed`);
    }
    if (!descriptor.enumerable) {
      fail('input', `property "${key}" must be enumerable`);
    }
    if (!FIELD_SET.has(key)) fail('input', `unknown field "${key}"`);
  }
  for (const field of ALLOWED_FIELDS) {
    if (!Object.hasOwn(descriptors, field)) fail(field, 'is required');
  }

  // Only after all descriptors have been vetted, read snapshotted values.
  const version = parseVersion(descriptors.version.value, 'version');
  const platform = descriptors.platform.value;
  const arch = descriptors.arch.value;

  if (platform !== 'win32') fail('platform', 'must be exactly "win32"');
  if (arch !== 'x64') fail('arch', 'must be exactly "x64"');

  const downloadUrl = validateDownloadUrl(descriptors.downloadUrl.value, trustedHosts);
  const sha256 = validateSha256(descriptors.sha256.value);
  const size = validateSize(descriptors.size.value);
  const publishedAt = validatePublishedAt(descriptors.publishedAt.value);

  return Object.freeze({
    version: version.raw,
    platform: 'win32',
    arch: 'x64',
    downloadUrl,
    sha256,
    size,
    publishedAt,
  });
}

/**
 * Decide what an update to `manifest` would mean relative to `current`.
 * Downgrades are reported as "downgrade-blocked"; this function never
 * performs or authorizes an installation itself.
 *
 * @param {string} current
 * @param {unknown} manifestInput
 * @param {{ trustedHosts: string[] }} options
 * @returns {Readonly<{status: 'upgrade'|'same'|'downgrade-blocked', manifest: object}>}
 */
export function planUpdate(current, manifestInput, options) {
  const currentVersion = parseVersion(current, 'current');
  const manifest = validateUpdateManifest(manifestInput, options);
  const nextVersion = parseVersion(manifest.version, 'version');

  const order = compareParsed(currentVersion, nextVersion);
  const status = order < 0 ? 'upgrade' : order === 0 ? 'same' : 'downgrade-blocked';

  return Object.freeze({ status, manifest });
}
