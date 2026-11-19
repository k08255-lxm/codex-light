import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectArtifact, ARTIFACT_LIMITS} from './artifacts.mjs';
import {WslFileScope} from './wsl-file-scope.mjs';
import {isAbsoluteWorkingDirectory} from './security.mjs';

export const FILE_PREVIEW_LIMITS = Object.freeze({bytes: 1024 * 1024, lines: 2000, concurrent: 4});
export const FILE_DOWNLOAD_LIMIT = 64 * 1024 * 1024;
const directoryEntryLimit = 250;
const attachmentExtension = /\.(?:pdf|docx?|xlsx?|pptx?|od[pts]|rtf|epub|zip|7z|rar|gz|tar|bz2|xz|apk|exe|msi|dll|mp[34]|m4[av]|mov|avi|mkv|wav|ogg|aac|flac|webm|jp2|avif|heic|bmp|tiff?)$/i;
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.svg']);
const fail = (message, code, status = 400) => Object.assign(new Error(message), {code, status, outcome: 'notExecuted'});
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);
const inside = (root, file) => {const relative = path.relative(root, file); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);};
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const unsafeWindowsName = source => source.split(/[\\/]/).some(part => part && !['.', '..'].includes(part) && !/^[A-Za-z]:$/.test(part) && (/[*?"<>|]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)));

async function checkPath(target, file = false) {
  const absolute = path.resolve(target), base = path.parse(absolute).root;
  let current = base;
  for (const part of absolute.slice(base.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw fail('文件预览不支持符号链接或 junction', 'FILE_PREVIEW_LINK_REFUSED', 403);
    if ((current !== absolute || !file) && !stat.isDirectory()) throw fail('文件目录无效', 'FILE_PREVIEW_PATH_INVALID', 403);
  }
}

function decodeText(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  let text;
  try {text = new TextDecoder(encoding, {fatal: true}).decode(bytes);}
  catch {throw fail('该文件不是 UTF-8 或 UTF-16 文本，暂不支持预览', 'FILE_PREVIEW_FORMAT_UNSUPPORTED', 415);}
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw fail('该文件是二进制文件，暂不支持预览', 'FILE_PREVIEW_FORMAT_UNSUPPORTED', 415);
  return text.replace(/\r\n?/g, '\n');
}

/** Authenticated file previews may read local absolute paths; thread/project cwd resolves relative links. */
export class FilePreviewService {
  constructor({projects, wslDistribution} = {}) {
    this.projects = projects;
    this.wsl = wslDistribution ? new WslFileScope(wslDistribution) : null;
    this.threads = new Map();
    this.pending = new Set();
    this.closed = false;
  }

  bindThread(thread) {
    if (!validId(thread?.id) || typeof thread.cwd !== 'string' || thread.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(thread.cwd)) return;
    if (!isAbsoluteWorkingDirectory(thread.cwd)) {
      if (!this.wsl) return;
      try {this.wsl.host(thread.cwd);} catch {return;}
    }
    this.threads.delete(thread.id);
    this.threads.set(thread.id, thread.cwd);
    if (this.threads.size > 1000) this.threads.delete(this.threads.keys().next().value);
  }

  async root(input) {
    if ((input.threadId === undefined) === (input.projectId === undefined)) throw fail('请选择一个已知对话或项目', 'FILE_PREVIEW_SCOPE_REQUIRED');
    let root;
    if (input.threadId !== undefined) {
      if (!validId(input.threadId)) throw fail('对话标识无效', 'FILE_PREVIEW_SCOPE_INVALID');
      root = this.threads.get(input.threadId);
    } else {
      if (!validId(input.projectId)) throw fail('项目标识无效', 'FILE_PREVIEW_SCOPE_INVALID');
      root = (await this.projects?.list())?.projects?.find(project => project.id === input.projectId)?.path;
    }
    if (!root) throw fail('相对文件路径需要已打开对话或项目的工作目录', 'FILE_PREVIEW_SCOPE_UNKNOWN', 403);
    if (typeof root !== 'string' || root.length > 4096 || /[\x00-\x1f\x7f]/.test(root)) throw fail('工作目录无效', 'FILE_PREVIEW_PATH_INVALID');
    return root;
  }

  async resolve(input) {
    let source = input.path;
    if (typeof source !== 'string' || !source || source.length > 4096) throw fail('文件路径无效', 'FILE_PREVIEW_PATH_INVALID');
    if (/^file:\/\//i.test(source)) {
      try {source = fileURLToPath(source);} catch {throw fail('文件地址无效', 'FILE_PREVIEW_PATH_INVALID');}
    }
    if (process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(source)) source = source.slice(1);
    if (/[\x00-\x1f\x7f]/.test(source) || source.replace(/^[A-Za-z]:[\\/]/, '').includes(':') || (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(source))) throw fail('需要有效的本地文件路径', 'FILE_PREVIEW_PATH_INVALID');
    // Reject network hosts before filesystem APIs can initiate an SMB connection.
    const unc = source.replaceAll('/', '\\').startsWith('\\\\');
    let selectedWsl = false, linuxSource = source;
    if (unc) {
      const match = /^[/\\]{2}(wsl\.localhost|wsl\$)[/\\]([^/\\]+)([/\\].*)?$/i.exec(source);
      if (!this.wsl || !match || match[2] !== this.wsl.distribution) throw fail('文件预览不支持网络共享路径', 'FILE_PREVIEW_NETWORK_REFUSED', 403);
      linuxSource = (match[3] || '/').replaceAll('\\', '/'); selectedWsl = true;
    }
    // Windows alternate streams, device aliases and trailing-dot aliases must never reach open().
    if (process.platform === 'win32' && unsafeWindowsName(source)) throw fail('文件路径包含不支持的名称', 'FILE_PREVIEW_PATH_INVALID');
    const driveAbsolute = /^[A-Za-z]:[\\/]/.test(source);
    let base;
    if (!unc && !driveAbsolute && !(source.startsWith('/') && (this.wsl || process.platform !== 'win32'))) base = await this.root(input);
    if (!driveAbsolute && this.wsl && (selectedWsl || source.startsWith('/') || (base && !/^[A-Za-z]:[\\/]/.test(base)))) {
      // Validate the selected distribution before normalizing dot segments so UNC
      // traversal can never turn Ubuntu into a different share or distribution.
      const linuxBase = base ? this.wsl.linux(base) : '/';
      if (linuxSource.includes('\\')) throw fail('WSL 文件路径无效', 'FILE_PREVIEW_PATH_INVALID');
      const filename = this.wsl.host(path.posix.resolve(linuxBase, linuxSource));
      return {filename, source, selectedWsl: true};
    }
    if (base?.replaceAll('/', '\\').startsWith('\\\\')) throw fail('文件预览不支持网络共享路径', 'FILE_PREVIEW_NETWORK_REFUSED', 403);
    const filename = base ? path.resolve(base, source) : path.resolve(source);
    if (filename.replaceAll('/', '\\').startsWith('\\\\')) throw fail('文件预览不支持网络共享路径', 'FILE_PREVIEW_NETWORK_REFUSED', 403);
    return {filename, source, selectedWsl: false};
  }

  preview(input) {return this.request(input, false);}
  download(input) {return this.request(input, true);}

  async request(input, download) {
    if (this.closed) throw fail('文件预览服务正在关闭', 'FILE_PREVIEW_CLOSED', 409);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['threadId', 'projectId', 'path', 'line', 'endLine'].includes(key))) throw fail('文件预览参数无效', 'FILE_PREVIEW_INPUT_INVALID');
    if (input.threadId !== undefined && input.projectId !== undefined) throw fail('请选择一个对话或项目', 'FILE_PREVIEW_SCOPE_REQUIRED');
    for (const key of ['threadId', 'projectId']) if (input[key] !== undefined && !validId(input[key])) throw fail('对话或项目标识无效', 'FILE_PREVIEW_SCOPE_INVALID');
    for (const key of ['line', 'endLine']) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > 10000000)) throw fail('文件行号无效', 'FILE_PREVIEW_LINE_INVALID');
    if (input.endLine !== undefined && (input.line === undefined || input.endLine < input.line)) throw fail('文件行号范围无效', 'FILE_PREVIEW_LINE_INVALID');
    if (this.pending.size >= FILE_PREVIEW_LIMITS.concurrent) throw fail('同时预览的文件过多，请稍后重试', 'FILE_PREVIEW_BUSY', 429);
    if (download && (input.line !== undefined || input.endLine !== undefined)) throw fail('下载请求不支持行号', 'FILE_PREVIEW_INPUT_INVALID');
    const operation = this.read(input, download);
    this.pending.add(operation);
    try {return await operation;} finally {this.pending.delete(operation);}
  }

  async requireProjectPath(input, target) {
    const base = await this.resolve({path: await this.root(input)});
    const contained = target.selectedWsl
      ? base.selectedWsl && this.wsl.inside(base.filename, target.filename)
      : !base.selectedWsl && (samePath(base.filename, target.filename) || inside(base.filename, target.filename));
    if (!contained) throw fail('只能浏览或下载当前对话或项目工作目录内的文件', 'FILE_PREVIEW_OUTSIDE_SCOPE', 403);
  }

  async listDirectory(target, before) {
    const {filename, selectedWsl} = target;
    const directoryPath = selectedWsl ? this.wsl.linux(filename) : filename;
    const entries = [];
    let truncated = false;
    const directory = await fs.opendir(filename);
    for await (const entry of directory) {
      if (!entry.isFile() && !entry.isDirectory()) continue;
      if (entries.length === directoryEntryLimit) {truncated = true; break;}
      const entryPath = (selectedWsl ? path.posix : path).join(directoryPath, entry.name);
      entries.push({name: entry.name, path: entryPath, kind: entry.isDirectory() ? 'directory' : 'file'});
    }
    await checkPath(filename);
    const after = await fs.lstat(filename);
    if (after.dev !== before.dev || after.ino !== before.ino) throw fail('目录已变化，请重试', 'FILE_PREVIEW_CHANGED', 409);
    entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', {numeric:true}) : a.kind === 'directory' ? -1 : 1);
    return {kind: 'directory', path: directoryPath, name: path.basename(filename) || directoryPath, entries, truncated};
  }

  async read(input, download) {
    let handle;
    try {
      const target = await this.resolve(input);
      const {filename, source, selectedWsl} = target, root = path.dirname(filename);
      if (download) await this.requireProjectPath(input, target);
      await checkPath(root);
      await checkPath(filename, true);
      const equal = selectedWsl ? (a, b) => a === b : samePath;
      const canonicalRoot = await fs.realpath(root), canonicalFile = await fs.realpath(filename);
      if (!equal(canonicalRoot, root) || !equal(canonicalFile, filename)) throw fail('文件目录已变化，请重新预览', 'FILE_PREVIEW_PATH_CHANGED', 409);
      const rootStat = await fs.lstat(root), before = await fs.lstat(filename);
      if (before.isDirectory() && !download) {
        await this.requireProjectPath(input, target);
        return await this.listDirectory(target, before);
      }
      if (!before.isFile() || before.nlink > 1) throw fail('此操作仅支持普通文件', 'FILE_PREVIEW_FILE_REFUSED', 403);
      const extension = path.extname(filename).toLowerCase(), isImage = imageExtensions.has(extension);
      const maxBytes = isImage ? (extension === '.svg' ? ARTIFACT_LIMITS.svgBytes : ARTIFACT_LIMITS.bytes) : FILE_PREVIEW_LIMITS.bytes;
      const meta = {name: path.basename(filename), path: source, bytes: before.size};
      const attachment = async () => {
        await this.requireProjectPath(input, target);
        if (before.size > FILE_DOWNLOAD_LIMIT) throw fail('文件超过下载上限（64 MiB）', 'FILE_PREVIEW_SIZE_LIMIT', 413);
        return {...meta, path: selectedWsl ? this.wsl.linux(filename) : filename, kind:'download'};
      };
      if (!download && (before.size > maxBytes || attachmentExtension.test(filename))) return await attachment();
      if (download && before.size > FILE_DOWNLOAD_LIMIT) throw fail('文件超过下载上限（64 MiB）', 'FILE_PREVIEW_SIZE_LIMIT', 413);
      handle = await fs.open(canonicalFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw fail('文件已变化，请重试', 'FILE_PREVIEW_CHANGED', 409);
      const bytes = Buffer.alloc(opened.size);
      let count = 0;
      while (count < bytes.length) {const result = await handle.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead;}
      const after = await handle.stat(), afterPath = await fs.lstat(filename), afterRoot = await fs.lstat(root);
      await checkPath(root); await checkPath(filename, true);
      if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || afterPath.ino !== opened.ino || afterPath.dev !== opened.dev || afterPath.nlink > 1 || afterRoot.ino !== rootStat.ino || afterRoot.dev !== rootStat.dev || !equal(await fs.realpath(root), canonicalRoot) || !equal(await fs.realpath(filename), canonicalFile)) throw fail('文件在读取时发生变化，请重试', 'FILE_PREVIEW_CHANGED', 409);
      if (download) return {name: meta.name, bytes};
      if (isImage) return {...meta, kind: 'image', base64: bytes.toString('base64'), ...inspectArtifact(bytes, extension)};
      let text;
      try {text = decodeText(bytes);} catch (error) {
        if (error.code === 'FILE_PREVIEW_FORMAT_UNSUPPORTED') return await attachment();
        throw error;
      }
      const lines = text.split('\n'), totalLines = lines.length;
      const line = input.line === undefined ? null : Math.min(input.line, totalLines);
      const start = Math.max(0, Math.min((line ?? 1) - 1 - FILE_PREVIEW_LIMITS.lines / 4, totalLines - FILE_PREVIEW_LIMITS.lines));
      return {...meta, kind: 'text', text: lines.slice(start, start + FILE_PREVIEW_LIMITS.lines).join('\n'), startLine: start + 1, totalLines, line, endLine: line === null ? null : Math.min(input.endLine ?? line, totalLines), truncated: totalLines > FILE_PREVIEW_LIMITS.lines};
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw fail('文件不存在或已被移动', 'FILE_PREVIEW_NOT_FOUND', 404);
      if (['EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw fail('无法安全读取该文件', 'FILE_PREVIEW_ACCESS_DENIED', 403);
      throw error;
    } finally {await handle?.close();}
  }

  async close() {this.closed = true; await Promise.allSettled([...this.pending]); this.threads.clear();}
}
