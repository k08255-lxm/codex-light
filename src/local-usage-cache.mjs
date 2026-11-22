import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// Bump the version whenever the parser changes the meaning or shape of its projection.
const header = 'CodeCang local usage index v1 ';
const indexName = 'local-usage-index.cache';
const maxBytes = 16 * 1024 * 1024;
const maxEntries = 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const unsafe = () => Object.assign(new Error('Unsafe usage index path'), {code:'UNSAFE_CACHE_PATH'});
const invalid = () => Object.assign(new Error('Damaged or incompatible usage index'), {code:'INVALID_USAGE_INDEX'});

async function checkDirectory(directory, create = false) {
  const start = path.parse(directory).root;
  let current = start;
  for (const part of directory.slice(start.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await fs.mkdir(current, {mode:0o700}); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
  }
}

async function regularFile(file) {
  const stat = await fs.lstat(file, {bigint:true});
  if (!stat.isFile() || stat.nlink !== 1n || stat.isSymbolicLink()) throw unsafe();
  return stat;
}

const sameFile = (a,b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function load(directory, file) {
  await checkDirectory(directory);
  const before = await regularFile(file);
  if (before.size > maxBytes) throw invalid();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  let data;
  try {
    if (!sameFile(before, await handle.stat({bigint:true}))) throw unsafe();
    data = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < data.length) {
      const read = await handle.read(data, offset, data.length - offset, offset);
      if (!read.bytesRead) throw invalid();
      offset += read.bytesRead;
    }
    await checkDirectory(directory);
    if (!sameFile(before, await regularFile(file)) || !sameFile(before, await handle.stat({bigint:true}))) throw unsafe();
  } finally { await handle.close(); }
  const body = data.subarray(header.length + 65);
  if (data.subarray(0, header.length + 65).toString('ascii') !== header + digest(body) + '\n') throw invalid();
  let entries;
  try { entries = JSON.parse(body.toString('utf8')); } catch { throw invalid(); }
  if (!Array.isArray(entries) || entries.length > maxEntries || entries.some(entry =>
    !entry || !/^[a-f0-9]{64}$/.test(entry.root) || typeof entry.identity !== 'string' ||
    !Number.isSafeInteger(entry.expanded) || entry.expanded < 0 || entry.expanded > 32 * 1024 * 1024 ||
    entry.parsed?.source !== 'local-codex-jsonl' || typeof entry.parsed.sourceId !== 'string' ||
    !Array.isArray(entry.parsed.increments) || !Array.isArray(entry.parsed.turns) ||
    !Array.isArray(entry.parsed.diagnostics) || !entry.parsed.diagnosticCounts)) throw invalid();
  return entries;
}

async function save(directory, file, entries) {
  const rows = [];
  let bytes = Buffer.byteLength(header) + 65 + 2;
  for (const entry of entries) {
    if (rows.length >= maxEntries) break;
    const row = JSON.stringify(entry);
    const size = Buffer.byteLength(row) + (rows.length ? 1 : 0);
    if (bytes + size > maxBytes) continue;
    rows.push(row);
    bytes += size;
  }
  const body = '[' + rows.join(',') + ']';
  await checkDirectory(directory, true);
  const temporary = path.join(directory, '.' + indexName + '-' + randomUUID());
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(header + digest(body) + '\n' + body); await handle.sync(); }
    finally { await handle.close(); }
    await checkDirectory(directory);
    try { await regularFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(temporary, file);
  } finally {
    await checkDirectory(directory);
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// Only entries visited in this scan can reach the result. Eviction or concurrent replacement
// can cause another cold read, but a projection is always checked against the open source file.
export async function openLocalUsageIndex(cacheRoot, sourceRoot, report) {
  if (!cacheRoot) return null;
  if (typeof cacheRoot !== 'string' || !path.isAbsolute(cacheRoot)) { report('usage-index-unsafe'); return null; }
  const directory = path.resolve(cacheRoot);
  const relative = path.relative(sourceRoot, directory);
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
    report('usage-index-unsafe');
    return null;
  }
  const file = path.join(directory, indexName);
  let entries = [], dirty = false;
  try { entries = await load(directory, file); }
  catch (error) {
    if (error.code === 'INVALID_USAGE_INDEX') { report('usage-index-invalid'); dirty = true; }
    else if (error.code !== 'ENOENT') {
      report(error.code === 'UNSAFE_CACHE_PATH' ? 'usage-index-unsafe' : 'usage-index-read-failed');
      return null;
    }
  }
  const root = digest(sourceRoot);
  const existing = new Map(entries.filter(entry => entry.root === root).map(entry => [entry.parsed.sourceId, entry]));
  const current = [];
  return {
    get(id) { return existing.get(id); },
    remember(identity, expanded, parsed) {
      const old = existing.get(parsed.sourceId);
      if (old?.identity === identity) current.push(old);
      else { dirty = true; current.push({root, identity, expanded, parsed}); }
    },
    async finish() {
      if (!dirty && existing.size === current.length) return;
      try { await save(directory, file, [...current, ...entries.filter(entry => entry.root !== root)]); }
      catch (error) { report(error.code === 'UNSAFE_CACHE_PATH' ? 'usage-index-unsafe' : 'usage-index-write-failed'); }
    },
  };
}
