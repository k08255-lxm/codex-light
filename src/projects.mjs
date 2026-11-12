import {access, lstat, mkdir, open, realpath, rename, stat, unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {projectName} from '../public/projects.js';

const MAX_BYTES = 128 * 1024;
const MAX_PROJECTS = 50;
const stateError = () => new Error('项目列表无法安全读取或保存；原有列表未被替换。');
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;

async function noLinks(file) {
  for (let current = path.resolve(file);; current = path.dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw stateError(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}

export class ProjectStore {
  constructor({root, platform = process.platform} = {}) {
    root ??= platform === 'win32' ? (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CodexLight', 'state') : null) : path.join(homedir(), '.local', 'share', 'codex-light', 'state');
    if (!root || !path.isAbsolute(root)) throw stateError();
    this.root = root;
    this.file = path.join(root, 'projects.json');
    this.paths = platform === 'win32' ? path.win32 : path.posix;
    this.platform = platform;
    this.queue = Promise.resolve();
  }

  validPath(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && this.paths.isAbsolute(value);
  }

  key(value) {
    const normalized = this.paths.normalize(value);
    return this.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  validate(value) {
    if (!keysAre(value, 'projects,selectedId,version') || value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > MAX_PROJECTS) throw stateError();
    const ids = new Set(), paths = new Set();
    for (const project of value.projects) {
      if (!keysAre(project, 'id,name,path') || typeof project.id !== 'string' || !/^[a-f0-9]{32}$/.test(project.id) || !this.validPath(project.path) || typeof project.name !== 'string' || project.name !== projectName(project.path) || ids.has(project.id) || paths.has(this.key(project.path))) throw stateError();
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
      if (error.code === 'ENOENT') return {version: 1, projects: [], selectedId: null};
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

  async list() { await this.queue; return this.read(); }

  add(value) {
    return this.update(async snapshot => {
      const canonical = await this.directory(value);
      let project = snapshot.projects.find(item => this.key(item.path) === this.key(canonical));
      if (!project) {
        if (snapshot.projects.length >= MAX_PROJECTS) throw new Error('最多保存 50 个项目，请先移除不再使用的项目。');
        project = {id: randomBytes(16).toString('hex'), path: canonical, name: projectName(canonical)};
        snapshot.projects.push(project);
      }
      snapshot.selectedId = project.id;
    });
  }

  select(id) {
    return this.update(async snapshot => {
      const project = snapshot.projects.find(item => item.id === id);
      if (!project) throw new Error('找不到该项目，请刷新项目列表。');
      await this.directory(project.path);
      snapshot.selectedId = project.id;
    });
  }

  remove(id) {
    return this.update(snapshot => {
      if (!snapshot.projects.some(item => item.id === id)) throw new Error('找不到该项目，请刷新项目列表。');
      snapshot.projects = snapshot.projects.filter(item => item.id !== id);
      if (snapshot.selectedId === id) snapshot.selectedId = null;
    });
  }
}
