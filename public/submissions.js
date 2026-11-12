// Mutation identity + minimal durable markers. No prompt, cwd, credentials or result is persisted.
const METHODS = new Set(['thread/start', 'turn/start', 'turn/steer', 'thread/compact/start', 'turn/interrupt', 'thread/name/set', 'thread/archive', 'thread/unarchive', 'thread/fork', 'review/start', 'remoteControl/enable', 'remoteControl/disable', 'remoteControl/pairing/start', 'remoteControl/client/revoke', 'terminal/open', 'account/start', 'account/cancel', 'account/logout', 'plugin/apply', 'git/apply', 'config/apply', 'runtime/upgrade']);
// Both start and steer carry the same owned attachment envelope.
const ATTACHMENT_METHODS = new Set(['turn/start', 'turn/steer']);
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const stableVersion = value => typeof value === 'string' && value.length <= 256 && STABLE_VERSION.test(value);
const INSTANCE = /^[a-f0-9]{32}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = 'codex-light-pending-v1';
function metadata(record) {
  return { requestId: record.requestId, method: record.method, serverInstance: record.serverInstance,
    createdAt: record.createdAt, threadId: record.threadId || null, turnId: record.turnId || null,
    status: record.status === 'pending' ? 'pending' : record.status === 'inFlight' ? 'inFlight' : 'unknown' };
}
export function makeMutation(serverInstance, method, params, { now = Date.now(), uuid = globalThis.crypto.randomUUID(), attachmentIds = [], fileAttachmentIds = [], confirmedFileAttachmentIds = [], confirmed = false } = {}) {
  if (!INSTANCE.test(serverInstance || '')) throw new Error('尚未获取本地服务实例，不能安全发送请求。');
  if (!METHODS.has(method)) throw new Error('该操作不属于支持的任务变更。');
  if (!Number.isSafeInteger(now) || now < 0 || !UUID.test(uuid)) throw new Error('无法生成有效的请求标识。');
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 5 || new Set(attachmentIds).size !== attachmentIds.length || attachmentIds.some(id => !UUID.test(id)) || (attachmentIds.length && !ATTACHMENT_METHODS.has(method))) throw new Error('附件请求标识无效。');
  for (const ids of [fileAttachmentIds, confirmedFileAttachmentIds]) if (!Array.isArray(ids) || ids.length > 5 || new Set(ids).size !== ids.length || ids.some(id => !UUID.test(id)) || (ids.length && !ATTACHMENT_METHODS.has(method))) throw new Error('文件附件请求标识无效。');
  if (attachmentIds.length + fileAttachmentIds.length > 5 || confirmedFileAttachmentIds.some(id => !fileAttachmentIds.includes(id))) throw new Error('附件总数或风险确认无效。');
  const clone = JSON.parse(JSON.stringify(params));
  const requestId = `${serverInstance}:${now}:${uuid}`;
  return { envelope: { requestId, method, params: clone, ...(confirmed === true ? {confirmed:true} : {}), ...(attachmentIds.length ? {attachmentIds: [...attachmentIds]} : {}), ...(fileAttachmentIds.length ? {fileAttachmentIds:[...fileAttachmentIds]} : {}), ...(confirmedFileAttachmentIds.length ? {confirmedFileAttachmentIds:[...confirmedFileAttachmentIds]} : {}) }, marker: { requestId, method, serverInstance, createdAt: now,
    threadId: typeof clone.threadId === 'string' ? clone.threadId : null,
    turnId: typeof clone.turnId === 'string' ? clone.turnId : null, status: 'inFlight' } };
}
export function serializeMarkers(records) { return JSON.stringify([...records].map(metadata)); }
export function restoreMarkers(raw) {
  if (!raw) return [];
  if (raw.length > 32768) throw new Error('待确认请求记录过大，已暂停发送以防重复。');
  let rows; try { rows = JSON.parse(raw); } catch { throw new Error('待确认请求记录损坏，已暂停发送以防重复。'); }
  if (!Array.isArray(rows) || rows.length > 20) throw new Error('待确认请求记录格式无效，已暂停发送。');
  return rows.map(row => {
    const parts = typeof row?.requestId === 'string' ? row.requestId.split(':') : [];
    if (!METHODS.has(row?.method) || !INSTANCE.test(row?.serverInstance || '') || parts.length !== 3 || parts[0] !== row.serverInstance || !/^\d+$/.test(parts[1]) || !UUID.test(parts[2]) || !Number.isSafeInteger(row.createdAt) || String(row.createdAt) !== parts[1]) throw new Error('待确认请求标识无效，已暂停发送。');
    for (const key of ['threadId', 'turnId']) if (row[key] != null && (typeof row[key] !== 'string' || row[key].length > 256)) throw new Error('待确认请求关联信息无效。');
    return { ...metadata(row), status: 'unknown', restored: true };
  });
}
export function outcomeFromError(error) {
  if (error?.outcome === 'notExecuted' || error?.notExecuted === true) return 'notExecuted';
  if (error?.outcome === 'failed') return 'failed';
  return 'unknown';
}
export class PendingMutations {
  constructor(storage, { key = KEY, now = () => Date.now(), uuid = () => globalThis.crypto.randomUUID() } = {}) {
    this.storage = storage; this.key = key; this.now = now; this.uuid = uuid; this.records = new Map(); this.envelopes = new Map(); this.storageError = null;
    try { for (const marker of restoreMarkers(storage.getItem(key))) this.records.set(marker.requestId, marker); }
    catch (error) { this.storageError = error.message; }
  }
  commit(next) {
    try { if (next.size) this.storage.setItem(this.key, serializeMarkers(next.values())); else this.storage.removeItem(this.key); }
    catch { this.storageError = '无法保存待确认请求记录。为避免重复任务，已暂停新的发送。'; throw new Error(this.storageError); }
    this.records = next; this.storageError = null;
  }
  begin(serverInstance, method, params, {attachmentIds = [], fileAttachmentIds = [], confirmedFileAttachmentIds = [], confirmed = false} = {}) {
    if (this.storageError) throw new Error(this.storageError);
    if (this.records.size >= 20) throw new Error('待确认请求过多，请先确认已有请求。');
    const operation = makeMutation(serverInstance, method, params, { now: this.now(), uuid: this.uuid(), attachmentIds, fileAttachmentIds, confirmedFileAttachmentIds, confirmed });
    if (this.records.has(operation.marker.requestId)) throw new Error('请求标识重复，未发送。');
    const next = new Map(this.records); next.set(operation.marker.requestId, operation.marker); this.commit(next);
    this.envelopes.set(operation.marker.requestId, operation.envelope); return structuredClone(operation.envelope);
  }
  envelope(requestId) { const envelope = this.envelopes.get(requestId); return envelope ? structuredClone(envelope) : null; }
  mark(requestId, status = 'unknown') {
    const old = this.records.get(requestId); if (!old) return;
    const next = new Map(this.records); next.set(requestId, { ...old, status, restored: false });
    try { this.commit(next); } catch (error) { this.records = next; throw error; }
  }
  settle(requestId) {
    if (!this.records.has(requestId)) return;
    const next = new Map(this.records); next.delete(requestId); this.commit(next); this.envelopes.delete(requestId);
  }
  values() { return [...this.records.values()].map(row => ({ ...row })); }
  has(method, threadId, turnId) { return this.values().some(row => row.method === method && row.threadId === threadId && (!turnId || row.turnId === turnId)); }
  get blocked() { return !!this.storageError || this.records.size > 0; }
  // Only an explicit user decision may discard a corrupted marker store.
  resetAfterExplicitConfirmation() { this.storage.removeItem(this.key); this.records.clear(); this.envelopes.clear(); this.storageError = null; }
}
// A read-only lookup is not permission to replay. In particular, notFound is not
// proof that an earlier network request cannot still arrive at the server.
export function lookupDecision(marker, response) {
  if (!response || response.serverInstance !== marker.serverInstance || (response.method && response.method !== marker.method)) return 'unknown';
  if (response.state === 'succeeded' && marker.method === 'git/apply') return response.result?.outcome === 'completed' ? (response.result.exitCode === 0 ? 'succeeded' : 'failed') : response.result?.outcome === 'notExecuted' ? 'notExecuted' : 'unknown';
  if (response.state === 'succeeded' && ['plugin/apply','config/apply'].includes(marker.method)) return response.result?.outcome === 'succeeded' ? 'succeeded' : response.result?.outcome === 'not-executed' ? 'notExecuted' : 'unknown';
  if (response.state === 'succeeded' && marker.method === 'runtime/upgrade') { const result = response.result; if (result?.outcome === 'succeeded') return stableVersion(result.installedVersion) && result.restartRequired === true ? 'succeeded' : 'unknown'; if (result?.outcome === 'not-executed' || result?.outcome === 'notExecuted') return 'notExecuted'; return 'unknown'; }
  if (response.state === 'succeeded') return 'succeeded';
  if (response.state === 'failed' && response.outcome === 'notExecuted') return 'notExecuted';
  if (response.state === 'failed' && response.outcome === 'failed') return 'failed';
  if (response.state === 'pending') return 'pending';
  return 'unknown';
}
const SCOPE_METHODS = Object.freeze({
  terminal: new Set(['terminal/open']),
  git: new Set(['git/apply']),
  config: new Set(['config/apply']),
  plugin: new Set(['plugin/apply']),
  runtime: new Set(['runtime/upgrade'])
});
const CHAT_THREAD_METHODS = new Set(['turn/start','turn/steer','review/start','thread/compact/start']);
const THREAD_METHODS = new Set(['thread/name/set','thread/archive','thread/unarchive','thread/fork','review/start']);
function scopeThread(threadId){ return typeof threadId === 'string' && threadId ? threadId : null; }
export function pendingForScope(records,scope,{threadId=null}={}) {
  const list = Array.isArray(records) ? records : [];
  const current = scopeThread(threadId);
  if (scope === 'chat') return list.filter(row => {
    if (row?.method === 'thread/start') return current === null;
    if (CHAT_THREAD_METHODS.has(row?.method)) return current !== null && row.threadId === current;
    return false;
  });
  if (scope === 'thread') return list.filter(row => current === null ? row?.method === 'thread/start' : row?.threadId === current && THREAD_METHODS.has(row?.method));
  if (scope === 'remote') return list.filter(row => typeof row?.method === 'string' && row.method.startsWith('remoteControl/'));
  if (scope === 'account') return list.filter(row => typeof row?.method === 'string' && row.method.startsWith('account/'));
  if (Object.hasOwn(SCOPE_METHODS,scope)) return list.filter(row => SCOPE_METHODS[scope].has(row?.method));
  throw new Error('未知待确认操作范围，无法筛选记录。');
}
export class PendingReconciler {
  constructor({records,query,onResult,onError=()=>{},setTimeout,clearTimeout,interval=5000,maxBackoff=30000}={}) {
    if (typeof records !== 'function' || typeof query !== 'function' || typeof onResult !== 'function') throw new TypeError('records/query/onResult callbacks required');
    if (typeof onError !== 'function') throw new TypeError('onError must be a function');
    this.recordsSource = records; this.query = query; this.onResult = onResult; this.onError = onError;
    this.interval = Number.isFinite(interval) && interval > 0 ? interval : 5000;
    this.maxBackoff = Math.max(this.interval, Number.isFinite(maxBackoff) && maxBackoff > 0 ? maxBackoff : 30000);
    // Keep timer receivers explicit; bare browser timer functions can throw Illegal invocation.
    this._scheduleTimer = typeof setTimeout === 'function' ? (fn,ms) => setTimeout.call(globalThis,fn,ms) : (fn,ms) => globalThis.setTimeout(fn,ms);
    this._clearTimerFn = typeof clearTimeout === 'function' ? id => clearTimeout.call(globalThis,id) : id => globalThis.clearTimeout(id);
    this.generation = 0; this.active = false; this.destroyed = false; this.running = false;
    this.rerun = false; this.failures = 0; this.cursor = 0; this.timer = null; this.roundPromise = null;
  }
  records() { return this.recordsSource(); }
  _current(generation) { return !this.destroyed && this.active && generation === this.generation; }
  _clearTimer() {
    if (this.timer === null) return;
    try { this._clearTimerFn(this.timer); } catch {}
    this.timer = null;
  }
  _schedule(generation,delay) {
    this._clearTimer();
    this.timer = this._scheduleTimer(() => {
      this.timer = null;
      if (this._current(generation)) return this._startScan();
    }, delay);
  }
  setActive(value) {
    const active = value === true;
    if (this.destroyed || active === this.active) return;
    this.active = active; this.generation++; this.failures = 0; this.rerun = false; this._clearTimer();
    if (active) return this._startScan();
  }
  refresh() {
    if (this.destroyed || !this.active) return Promise.resolve();
    this._clearTimer();
    return this._startScan();
  }
  _startScan() {
    if (this.destroyed || !this.active) return Promise.resolve();
    if (this.running) { this.rerun = true; return this.roundPromise || Promise.resolve(); }
    this.running = true;
    const generation = this.generation;
    const round = (async () => {
      let outcome;
      try { outcome = await this._runRound(generation); }
      catch (error) {
        outcome = {reads:0,failures:1,hadRecords:true};
        if (this._current(generation)) { try { this.onError(null,error); } catch {} }
      }
      finally { this.running = false; this.roundPromise = null; }
      this._afterRound(generation,outcome);
    })();
    this.roundPromise = round;
    return round;
  }
  async _runRound(generation) {
    if (!this._current(generation)) return {reads:0,failures:0,hadRecords:false};
    const list = this.recordsSource();
    if (!Array.isArray(list) || !list.length) { this.cursor = 0; return {reads:0,failures:0,hadRecords:false}; }
    const count = Math.min(20,list.length), start = this.cursor % list.length;
    const items = Array.from({length:count},(_,index) => list[(start + index) % list.length]);
    this.cursor = (start + count) % list.length;
    const failures = await this._runPool(items,generation);
    return {reads:items.length,failures,hadRecords:true};
  }
  async _runPool(items,generation) {
    let next = 0, failures = 0;
    const worker = async () => {
      while (this._current(generation)) {
        const index = next++;
        if (index >= items.length) return;
        const marker = items[index];
        try {
          const response = await this.query(marker);
          if (!this._current(generation)) return;
          await this.onResult(marker,response);
          if (!this._current(generation)) return;
        } catch (error) {
          if (!this._current(generation)) return;
          failures++;
          try { this.onError(marker,error); } catch {}
        }
      }
    };
    await Promise.all([worker(),worker()]);
    return failures;
  }
  _afterRound(generation,outcome) {
    if (this.destroyed) return;
    if (generation !== this.generation) {
      if (this.active && this.rerun) { this.rerun = false; this._startScan(); }
      return;
    }
    if (!this.active) return;
    if (this.rerun) { this.rerun = false; this._startScan(); return; }
    const failures = Number.isFinite(outcome?.failures) ? outcome.failures : 0;
    this.failures = failures > 0 ? this.failures + 1 : 0;
    let remaining = false;
    try { remaining = this.recordsSource().length > 0; } catch { remaining = true; }
    if (!remaining) { this.failures = 0; this._clearTimer(); return; }
    const delay = failures > 0 ? Math.min(this.maxBackoff,this.interval * (2 ** Math.min(this.failures - 1,30))) : this.interval;
    this._schedule(generation,delay);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.active = false; this.generation++; this.rerun = false; this._clearTimer(); this.roundPromise = null;
  }
}
// One visible explanation for every disabled Send state. No retries or mutation.
export function sendAvailability({connected,serverInstance,sending,loadingThread,busy,uploadingImages,pending,cwd,hasContent}){
 if(!connected)return{disabled:true,reason:'尚未连接 Codex，消息没有发送。',action:'reconnect'};
 if(!serverInstance)return{disabled:true,reason:'正在核对本地服务身份，消息没有发送。',action:'reconnect'};
 if(sending)return{disabled:true,reason:'正在提交这条消息，请勿重复发送。'};
 if(loadingThread)return{disabled:true,reason:'正在恢复对话，请稍候。'};
 if(pending)return{disabled:true,reason:'这条消息的发送状态正在同步…',action:'pending'};
 if(busy)return{disabled:true,reason:'当前任务正在运行；结束或停止后可继续发送。',action:'stop'};
 if(uploadingImages)return{disabled:true,reason:'正在本地准备附件，完成后可发送。'};
 if(!cwd)return{disabled:true,reason:'先选择工作目录，Codex 才知道在哪里读取和修改文件。',action:'cwd'};
 if(!hasContent)return{disabled:true,reason:'输入消息，或添加图片 / 文件。'};
 return{disabled:false,reason:'',action:null};
}
export class ConnectionBootstrap {
 constructor(load,onError=()=>{}){this.load=load;this.onError=onError;this.generation=0;this.key=null;this.connected=false;this.started=false;}
 // Late readiness must load even when the server instance is not known yet; the
 // key is rechecked when the real instance arrives, so stale results are dropped.
 update(connected,key){const nextKey=key??null;if(this.connected!==connected||this.key!==nextKey){this.generation++;this.connected=connected;this.key=nextKey;this.started=false;}if(!connected||this.started)return;this.started=true;const generation=this.generation;const current=()=>this.connected&&generation===this.generation;Promise.resolve().then(()=>{if(current())return this.load(current);}).catch(error=>{if(current())this.onError(error);});}
 retry(){this.generation++;this.started=false;this.update(this.connected,this.key);}
}
// Exactly one hook for a connection loss. A failing terminal callback is not
// swallowed: the caller must report it while still completing other cleanup.
export function notifyConnectionLost(view){if(!view||typeof view.connectionLost!=='function')return false;view.connectionLost();return true;}
const SESSION_DEFAULT_FIELDS=['model','modelProvider','reasoningEffort'];
function sessionDefaultText(value){return typeof value==='string'&&value.trim()?value.trim().slice(0,512):null;}
// Only the three documented fields are ever accepted; anything else is dropped.
export function sanitizeSessionDefaults(raw){const clean={model:null,modelProvider:null,reasoningEffort:null};if(!raw||typeof raw!=='object'||Array.isArray(raw))return clean;for(const key of SESSION_DEFAULT_FIELDS)clean[key]=sessionDefaultText(raw[key]);return clean;}
export class SessionDefaultsBridge {
 constructor(load,{onChange=()=>{}}={}){if(typeof load!=='function')throw new TypeError('defaults load callback required');this.load=load;this.onChange=onChange;this.generation=0;this.key=null;this.args=null;this.value=null;this.error=null;this.loading=false;}
 snapshot(){return {value:this.value,error:this.error,loading:this.loading};}
 notify(){this.onChange(this.snapshot());}
 clear(){if(this.key===null&&!this.loading&&!this.value&&!this.error)return;this.generation++;this.key=null;this.value=null;this.error=null;this.loading=false;this.notify();}
 sync({connected=false,serverInstance=null,cwd='',enabled=true}={}){
  const instance=typeof serverInstance==='string'&&serverInstance?serverInstance:null;
  this.args={connected:!!connected,serverInstance:instance,cwd:typeof cwd==='string'?cwd:'',enabled:enabled!==false};
  if(!this.args.enabled||!this.args.connected||!instance){this.clear();return false;}
  const key=instance+'\u0000'+this.args.cwd;
  if(key===this.key)return false;
  this.key=key;this.value=null;this.error=null;this.loading=true;const generation=++this.generation;this.notify();
  const body=this.args.cwd?{cwd:this.args.cwd}:{};
  Promise.resolve().then(()=>this.load(body)).then(raw=>{if(generation!==this.generation)return;this.value=sanitizeSessionDefaults(raw);this.loading=false;this.error=null;this.notify();},error=>{if(generation!==this.generation)return;this.value=null;this.loading=false;this.error=typeof error?.message==='string'&&error.message?error.message:'无法读取 Codex 配置默认值';this.notify();});
  return true;
 }
 // A failure is retried only by this explicit call, never by a timer or event.
 retry(){const args=this.args;if(!args||!args.enabled||!args.connected||!args.serverInstance)return false;this.key=null;return this.sync(args);}
}
