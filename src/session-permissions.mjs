import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {plain} from './storage-maintenance.mjs';

const modes = new Set(['request','auto','full','custom']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validPermissionMode(value) { return modes.has(value); }

// Store choices independently from Codex config and history. Unidentified accounts
// only have a volatile namespace for the lifetime of their current connection.
export class SessionPermissions {
  constructor(root, runtime) {
    this.root = root && path.join(root, 'session-permissions');
    this.runtime = runtime;
    this.volatile = new Map();
    this.resetAnonymous();
  }
  resetAnonymous() { this.anonymous = randomUUID(); this.volatile.clear(); }
  scope(identity) { return hash([this.runtime, identity || this.anonymous]); }
  async access(identity, threadId, update) {
    if (typeof threadId !== 'string' || !threadId || threadId.length > 256 || /[\x00-\x1f]/.test(threadId)) throw new Error('对话标识无效');
    const scope = this.scope(identity), key = hash([scope, threadId]);
    if (update && (scope !== update.scope || !validPermissionMode(update.mode))) throw new Error('批准方式或账户已变化，请重新打开此对话。');
    if (!this.root || !identity) {
      if (update) this.volatile.set(key, update.mode);
      return {scope, mode:this.volatile.get(key) || null};
    }
    const file = path.join(this.root, key + '.json');
    await plain(file);
    if (update) {
      await mkdir(this.root, {recursive:true, mode:0o700});
      const temp = file + '.' + randomUUID();
      try {
        await writeFile(temp, JSON.stringify(update.mode), {flag:'wx', mode:0o600});
        await rename(temp, file);
      } finally { await rm(temp, {force:true}); }
      return {scope, mode:update.mode};
    }
    let mode, handle;
    try {
      handle=await open(file,'r');
      const bytes=Buffer.alloc(32), {bytesRead}=await handle.read(bytes);
      if(bytesRead===bytes.length)throw new Error('已保存的对话批准方式无效。');
      mode=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
    } catch (error) { if (error.code === 'ENOENT') return {scope, mode:null}; throw error; }
    finally { await handle?.close(); }
    if (!validPermissionMode(mode)) throw new Error('已保存的对话批准方式无效，请重新选择。');
    return {scope, mode};
  }
}
