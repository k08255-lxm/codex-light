import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {plain} from './storage-maintenance.mjs';

const modes = new Set(['request','auto','full','custom']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validPermissionMode(value) { return modes.has(value); }
export function validReasoningChoice(choice,{allowInherit=false}={}) {
  if(!choice || typeof choice!=='object' || Array.isArray(choice))return false;
  const fields=Object.keys(choice);
  return fields.length>0 && fields.every(key=>{
    if(key!=='model' && key!=='effort')return false;
    const value=choice[key];
    if(value===null)return allowInherit;
    if(typeof value!=='string')return false;
    return key==='effort'?/^[-\w]{1,64}$/.test(value):
      value.length>0 && value.length<=256 && value===value.trim() && !/[\x00-\x1f\x7f]/.test(value);
  });
}

// Store choices independently from Codex config and history. Unidentified accounts
// only have a volatile namespace for the lifetime of their current connection.
export class SessionPermissions {
  constructor(root, runtime) {
    this.root = root && path.join(root, 'session-permissions');
    this.reasoningRoot = root && path.join(root, 'session-reasoning');
    this.runtime = runtime;
    this.volatile = new Map();
    this.resetAnonymous();
  }
  resetAnonymous() { this.anonymous = randomUUID(); this.volatile.clear(); }
  scope(identity) { return hash([this.runtime, identity || this.anonymous]); }
  async access(identity, threadId, update) {
    const scope = this.scope(identity);
    if (update && (scope !== update.scope || !validPermissionMode(update.mode))) throw new Error('批准方式或账户已变化，请重新打开此对话。');
    const mode = await this.value(this.root,'permission',identity,threadId,update?.mode);
    if (mode!==null && !validPermissionMode(mode)) throw new Error('已保存的对话批准方式无效，请重新选择。');
    return {scope,mode};
  }
  // Used when a native thread cannot store the choice, including a turn owned by another process.
  async reasoning(identity,threadId,choice) {
    if(choice!=null && !validReasoningChoice(choice))throw new Error('对话模型或思考强度无效。');
    const value=await this.value(this.reasoningRoot,'reasoning',identity,threadId,choice);
    if(value!==null && !validReasoningChoice(value))throw new Error('已保存的对话模型或思考强度无效。');
    return {scope:this.scope(identity),choice:value};
  }
  async value(root,kind,identity,threadId,update) {
    if (typeof threadId !== 'string' || !threadId || threadId.length > 256 || /[\x00-\x1f]/.test(threadId)) throw new Error('对话标识无效');
    const key = hash([this.scope(identity), threadId]);
    if (!root || !identity) {
      const entry=kind+':'+key;
      if (update===null) this.volatile.delete(entry);
      else if(update!==undefined) this.volatile.set(entry, update);
      return this.volatile.get(entry) ?? null;
    }
    const file = path.join(root, key + '.json');
    await plain(file);
    if(update===null){await rm(file,{force:true});return null;}
    if (update!==undefined) {
      await mkdir(root, {recursive:true, mode:0o700});
      const temp = file + '.' + randomUUID();
      try {
        await writeFile(temp, JSON.stringify(update), {flag:'wx', mode:0o600});
        await rename(temp, file);
      } finally { await rm(temp, {force:true}); }
      return update;
    }
    let handle;
    try {
      handle=await open(file,'r');
      const bytes=Buffer.alloc(kind==='permission'?32:2048), {bytesRead}=await handle.read(bytes);
      if(bytesRead===bytes.length)throw new Error('已保存的对话设置无效。');
      return JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
  }
}
