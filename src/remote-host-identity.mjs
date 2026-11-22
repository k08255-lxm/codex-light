import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {link, lstat, mkdir, open, unlink} from 'node:fs/promises';
import path from 'node:path';

const invalid = () => Object.assign(new Error('无法安全读取或保存此电脑的远控 ID。请检查用户数据目录。'), {code:'REMOTE_ID_UNAVAILABLE'});

async function checkDirectory(directory) {
  for (let current = directory;; current = path.dirname(current)) {
    try {
      if (!(await lstat(current)).isDirectory()) throw invalid();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === path.dirname(current)) return;
  }
}

async function readId(file) {
  if (!(await lstat(file)).isFile()) throw invalid();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== 32) throw invalid();
    const id = await handle.readFile('utf8');
    if (!/^[a-f0-9]{32}$/.test(id)) throw invalid();
    return id;
  } finally {
    await handle.close();
  }
}

export async function loadRemoteHostId(directory) {
  if (!path.isAbsolute(directory)) throw invalid();
  const file = path.join(directory, 'host-id');
  await checkDirectory(directory);
  try { return await readId(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(directory, {recursive:true, mode:0o700});
  await checkDirectory(directory);
  const id = randomBytes(16).toString('hex');
  const temporary = path.join(directory, '.' + randomBytes(16).toString('hex'));
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(id); await handle.sync(); }
    finally { await handle.close(); }
    // Two desktop processes can start together. Publish only a complete ID, without replacing a winner.
    try { await link(temporary, file); return id; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return await readId(file);
  } finally {
    await unlink(temporary);
  }
}
