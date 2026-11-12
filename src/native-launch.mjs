import {spawn} from 'node:child_process';
import {open, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const MAX_MANIFEST_BYTES = 4096;
const invalidBuild = () => new Error('桌面构建不完整或路径不安全，请重新运行 desktop/build.ps1；没有启动后台。');
const missingBuild = () => new Error('尚未生成桌面构建，请先运行 desktop/build.ps1；没有启动后台。');
const inside = (directory, candidate) => {
  const relative = path.relative(directory, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

export async function resolveNativeExecutable(root = repoRoot) {
  const distribution = path.resolve(root, 'desktop', 'dist');
  const manifest = path.join(distribution, 'current.json');
  let handle;
  try {
    const canonicalDistribution = await realpath(distribution);
    const canonicalManifest = await realpath(manifest);
    if (!inside(canonicalDistribution, canonicalManifest)) throw invalidBuild();
    handle = await open(canonicalManifest, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw invalidBuild();
    const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let count = 0;
    while (count <= MAX_MANIFEST_BYTES) {
      const result = await handle.read(bytes, count, MAX_MANIFEST_BYTES + 1 - count, null);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > MAX_MANIFEST_BYTES) throw invalidBuild();
    const value = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'directory' || typeof value.directory !== 'string' || !/^CodexLight-win-x64-[A-Za-z0-9-]+$/.test(value.directory)) throw invalidBuild();
    const directory = await realpath(path.join(canonicalDistribution, value.directory));
    if (!inside(canonicalDistribution, directory) || !(await stat(directory)).isDirectory()) throw invalidBuild();
    const executable = await realpath(path.join(directory, 'CodexLight.exe'));
    const backend = await realpath(path.join(directory, 'app', 'src', 'desktop-backend.mjs'));
    if (!inside(directory, executable) || !inside(directory, backend) || !(await stat(executable)).isFile() || !(await stat(backend)).isFile()) throw invalidBuild();
    return executable;
  } catch (error) {
    if (error.code === 'ENOENT' && !handle) throw missingBuild();
    throw invalidBuild();
  } finally { await handle?.close(); }
}

export async function launchNative({root = repoRoot, args = [], spawnProcess = spawn} = {}) {
  if (args.includes('--codex') || args.some(argument => argument.startsWith('--codex='))) throw new Error('Windows 原生入口请用 CODEX_LIGHT_CODEX 指定 Codex 路径，或显式添加 --browser 使用浏览器开发模式；没有启动后台。');
  if (args.some(argument => argument !== '--demo')) throw new Error('Windows 原生入口仅支持 --demo；浏览器开发模式请显式添加 --browser。没有启动后台。');
  const executable = await resolveNativeExecutable(root);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args.includes('--demo') ? ['--demo'] : [], {cwd: path.dirname(executable), detached: true, windowsHide: false, stdio: 'ignore', shell: false});
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child); });
  });
}
