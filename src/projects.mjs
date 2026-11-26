import {WslFileScope} from './wsl-file-scope.mjs';
import {access, lstat, mkdir, open, realpath, rename, stat, unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {projectName,projectPathKey} from '../public/projects.js';

const MAX_BYTES = 384 * 1024;
const MAX_PROJECTS = 50;
const MAX_SUBMISSIONS = 1000;
const validNavigationDepth = value => Number.isInteger(value) && value >= 30 && value <= 300;
const validNavigation = order => Array.isArray(order) && order.length <= 350 && new Set(order).size === order.length && order.every(key => typeof key === 'string' && key.length <= 4096 && (/^@(?:saved:[a-f0-9]{32}|other|projectless)$/.test(key) || !!projectPathKey(key)));
const stateError = () => new Error('项目列表无法安全读取或保存；原有列表未被替换。');
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;
const activityAt = value => Number.isSafeInteger(value) && value > 0;
const validThread = value => typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value);

export function projectListSnapshot({submissions, awaitingSelection, ...snapshot}, initialCwd) {
  // Legacy registries use null for "no project". Only a fresh registry with no
  // explicit choice inherits the launch directory, even after recording activity.
  if (initialCwd !== undefined) snapshot.draftCwd = awaitingSelection ? initialCwd : snapshot.projects.find(project=>project.id===snapshot.selectedId)?.path || '';
  return snapshot;
}

// Ask the running Windows shell to explore a folder object. explorer.exe can
// exit successfully or with code 1 merely for handing off to another process.
const exploreFolderScript = [
  "$ErrorActionPreference='Stop'",
  '$shell=New-Object -ComObject Shell.Application',
  '$folder=$shell.NameSpace($env:CODECANG_EXPLORER_DIRECTORY)',
  "if($null -eq $folder){throw 'Folder is unavailable'}",
  '$shell.Explore($folder.Self)',
].join(';');

export async function openProjectDirectory(directory) {
  if (process.platform !== 'win32') throw new Error('当前系统不支持 Windows 资源管理器。');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', exploreFolderScript], {
      env: {...process.env, CODECANG_EXPLORER_DIRECTORY: directory}, windowsHide: true, timeout: 15000,
    });
  } catch (error) {
    if (error.killed) throw new Error('Windows 资源管理器响应超时。', {cause: error});
    throw new Error('Windows 无法通过资源管理器打开此文件夹。', {cause: error});
  }
}

async function noLinks(file) {
  for (let current = path.resolve(file);; current = path.dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw stateError(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}

export class ProjectStore {
  constructor({root, platform = process.platform, wslDistribution} = {}) {
    root ??= platform === 'win32' ? (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CodexLight', 'state') : null) : path.join(homedir(), '.local', 'share', 'codex-light', 'state');
    if (!root || !path.isAbsolute(root)) throw stateError();
    this.root = root;
    this.file = path.join(root, 'projects.json');
    this.paths = platform === 'win32' ? path.win32 : path.posix;
    this.platform = platform;
    this.wsl = wslDistribution ? new WslFileScope(wslDistribution) : null;
    this.queue = Promise.resolve();
  }

  validPath(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && this.paths.isAbsolute(value);
  }

  key(value) {
    const normalized = this.paths.normalize(value);
    if (this.wsl && /^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(normalized)) {
      const distribution = normalized.split('\\')[3];
      if (distribution === this.wsl.distribution) return this.wsl.host(normalized);
    }
    return this.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  validate(value) {
    const {awaitingSelection, navigationOrder, navigationDepth, ...fields} = value ?? {};
    if (navigationOrder !== undefined && !validNavigation(navigationOrder)) throw stateError();
    if (navigationDepth !== undefined && (!navigationOrder || !validNavigationDepth(navigationDepth))) throw stateError();
    if ((awaitingSelection !== undefined && (awaitingSelection !== true || fields.selectedId !== null)) ||
      (!keysAre(fields, 'projects,selectedId,version') && !keysAre(fields, 'projects,selectedId,submissions,version')) || value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > MAX_PROJECTS) throw stateError();
    if (value.submissions !== undefined && (!value.submissions || typeof value.submissions !== 'object' || Array.isArray(value.submissions) || Object.keys(value.submissions).length > MAX_SUBMISSIONS || Object.entries(value.submissions).some(([id, at]) => !validThread(id) || !activityAt(at)))) throw stateError();
    const ids = new Set(), paths = new Set();
    for (const project of value.projects) {
      const validName = typeof project.name === 'string' && (project.name === projectName(project.path) || (project.name.trim().length > 0 && project.name.length <= 120 && !/[\u0000-\u001f\u007f]/.test(project.name)));
      if (Object.keys(project).some(key => !['id','name','path','pinned','addedAt'].includes(key)) || (project.addedAt !== undefined && !activityAt(project.addedAt)) || (project.pinned !== undefined && typeof project.pinned !== 'boolean') || typeof project.id !== 'string' || !/^[a-f0-9]{32}$/.test(project.id) || !this.validPath(project.path) || !validName || ids.has(project.id) || paths.has(this.key(project.path))) throw stateError();
      ids.add(project.id);
      paths.add(this.key(project.path));
    }
    if (value.selectedId !== null && (typeof value.selectedId !== 'string' || !ids.has(value.selectedId))) throw stateError();
    return value;
  }

  async read() {
    await noLinks(this.file);
    let handle;
    try {
      handle = await open(this.file, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES) throw stateError();
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let count = 0;
      while (count <= MAX_BYTES) {
        const result = await handle.read(bytes, count, MAX_BYTES + 1 - count, null);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      if (count > MAX_BYTES) throw stateError();
      return this.validate(JSON.parse(bytes.subarray(0, count).toString('utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return {version: 1, projects: [], selectedId: null, awaitingSelection:true};
      throw stateError();
    } finally { await handle?.close(); }
  }

  async directory(value) {
    if (!this.validPath(value)) throw new Error('请选择有效的绝对项目文件夹路径（最多 4096 个字符）。');
    try {
      const canonical = await realpath(value);
      if (!this.validPath(canonical) || !(await stat(canonical)).isDirectory()) throw new Error();
      await access(canonical, constants.R_OK | constants.X_OK);
      return canonical;
    } catch { throw new Error('项目文件夹不存在、无法访问或不是文件夹，请重新选择。'); }
  }

  update(change) {
    const job = this.queue.then(async () => {
      const value = await this.read();
      await change(value);
      const bytes = Buffer.from(JSON.stringify(this.validate(value)));
      if (bytes.length > MAX_BYTES) throw stateError();
      await noLinks(this.root);
      await mkdir(this.root, {recursive: true, mode: 0o700});
      await noLinks(this.file);
      const temporary = path.join(this.root, '.projects-' + randomBytes(16).toString('hex'));
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = null;
        await noLinks(this.file);
        await rename(temporary, this.file);
      } finally {
        await handle?.close();
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return value;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async list({initialCwd} = {}) {
    await this.queue;
    return projectListSnapshot(await this.read(), initialCwd);
  }
  async submitted() { await this.queue; return (await this.read()).submissions || {}; }

  add(value, recent = true, select = true) {
    return this.update(async snapshot => {
      const canonical = await this.directory(value);
      let project = snapshot.projects.find(item => this.key(item.path) === this.key(canonical));
      if (!project) {
        if (snapshot.projects.length >= MAX_PROJECTS) throw new Error('最多保存 50 个项目，请先移除不再使用的项目。');
        project = {id: randomBytes(16).toString('hex'), path: canonical, name: projectName(canonical), ...(recent ? {addedAt: Date.now()} : {})};
        snapshot.projects.push(project);
      }
      if(select){delete snapshot.awaitingSelection;snapshot.selectedId = project.id;}
    });
  }

  select(id) {
    return this.update(async snapshot => {
      delete snapshot.awaitingSelection;
      if (id === null) { snapshot.selectedId = null; return; }
      const project = snapshot.projects.find(item => item.id === id);
      if (!project) throw new Error('找不到该项目，请刷新项目列表。');
      await this.directory(project.path);
      snapshot.selectedId = project.id;
    });
  }

  saveNavigationOrder(order, depth = 30) {
    if (!validNavigationDepth(depth) || !validNavigation(order) || Buffer.byteLength(JSON.stringify(order)) > 96 * 1024) throw new Error('项目排列数据无效或过大。');
    return this.update(snapshot => { snapshot.navigationOrder = order; snapshot.navigationDepth = depth; });
  }

  recordSubmission(id, at) {
    if (!validThread(id) || !activityAt(at)) throw stateError();
    return this.update(snapshot => {
      const previous = Object.entries(snapshot.submissions || {}).filter(([threadId]) => threadId !== id);
      const sameThread = Object.hasOwn(snapshot.submissions || {}, id) ? snapshot.submissions[id] : 0;
      snapshot.submissions = Object.fromEntries([[id, Math.max(at, sameThread)], ...previous.slice(0, MAX_SUBMISSIONS - 1)]);
    });
  }

  async createProjectlessDirectory(id) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw stateError();
    const directory = path.join(this.root, 'projectless-threads', id);
    await noLinks(directory);
    await mkdir(directory, {recursive: true, mode: 0o700});
    await noLinks(directory);
    return directory;
  }

  remove(id) {
    return this.update(snapshot => {
      if (!snapshot.projects.some(item => item.id === id)) throw new Error('找不到该项目，请刷新项目列表。');
      snapshot.projects = snapshot.projects.filter(item => item.id !== id);
      if (snapshot.selectedId === id) snapshot.selectedId = null;
    });
  }

  updateMetadata(id, changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).some(key => !['name', 'pinned'].includes(key))) throw new Error('项目参数无效');
    if (Object.hasOwn(changes, 'name') && (typeof changes.name !== 'string' || !changes.name.trim() || changes.name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(changes.name))) throw new Error('项目名称需要 1–120 个字符，不能包含控制字符。');
    if (Object.hasOwn(changes, 'pinned') && typeof changes.pinned !== 'boolean') throw new Error('置顶状态无效');
    return this.update(snapshot => {
      const project = snapshot.projects.find(item => item.id === id);
      if (!project) throw new Error('找不到该项目，请刷新项目列表。');
      if (Object.hasOwn(changes, 'name')) project.name = changes.name.trim();
      if (Object.hasOwn(changes, 'pinned')) project.pinned = changes.pinned;
    });
  }
}
