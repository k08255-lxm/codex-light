import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

// This isolates checkouts, not operating-system access. The DSH permission
// sandbox must still enforce workspace-write/read-only. Never copy a dirty
// checkout incompletely, reset a caller's checkout, or remove old worktrees.
export const ISOLATION_MODE = 'git-worktree';
export const isolationEnabled = config => config.workspaceIsolation === ISOLATION_MODE;

export function requireThreadId(threadId) {
  if (typeof threadId !== 'string' || !threadId.trim() || threadId.includes('\0') || threadId.length > 4096)
    throw new Error('Workspace isolation requires the exact Codex conversation ID in MCP _meta.threadId. No task was started. Use a client that supplies it; do not guess an ID or use a shared fallback.');
  return threadId; // Whitespace/case are significant. Do not normalize identity.
}

const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
function inside(parent, child) {
  const part = relative(parent, child);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
}
const canonical = path => realpathSync.native(path);
function canonicalFuture(path) {
  if (existsSync(path)) return canonical(path);
  const parent = dirname(path);
  if (parent === path) throw new Error('Cannot resolve workspace isolation directory');
  return join(canonicalFuture(parent), relative(parent, path));
}
function git(cwd, args, hooksDirectory) {
  // Inherited Git overrides must never redirect a worktree/index operation to
  // another checkout. No shell interpolation and no credential prompts.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, {GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'});
  const config = ['-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', '-c', 'submodule.recurse=false'];
  if (hooksDirectory) config.push('-c', `core.hooksPath=${hooksDirectory}`);
  const result = spawnSync('git', [...config, '-C', cwd, ...args], {encoding: 'utf8', env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120000});
  if (result.error) throw new Error(`Workspace isolation Git check failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Workspace isolation Git check failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 2000)}`);
  return result.stdout;
}
function sourceInfo(cwd) {
  let root;
  try {
    if (git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') throw new Error('not a working tree');
    root = canonical(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  } catch (error) {
    throw new Error(`Workspace isolation needs a Git working tree with a committed snapshot. This cwd cannot be safely isolated; prepare an explicit snapshot in a clean Git repository. Original files were not changed. ${error.message}`);
  }
  if (!inside(root, cwd)) throw new Error('cwd resolves outside the source Git working tree');
  const common = canonical(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  return {root, common};
}
function assertClean(root) {
  // Ignored files are deliberately included: omitting local dependencies,
  // fixtures or unsaved inputs would silently change the task's filesystem.
  const changes = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none']);
  if (changes) throw new Error('Workspace isolation refused a source checkout containing modified, staged, untracked, or ignored files. Original files were preserved. Prepare an explicit complete snapshot in a clean Git repository or choose a clean isolated source cwd; files are never silently omitted, stashed, committed, or reset.');
  if (git(root, ['ls-files', '-v', '-z']).split('\0').some(row => /^[a-zS] /.test(row)))
    throw new Error('Workspace isolation cannot verify a checkout with assume-unchanged or skip-worktree files (including sparse checkouts). Prepare an explicit complete snapshot; original index flags and files were preserved.');
}
function assertSupportedTree(root, commit) {
  const tree = git(root, ['ls-tree', '-r', '-z', commit]);
  if (tree.split('\0').some(row => /^(120000|160000) /.test(row)))
    throw new Error('Workspace isolation does not yet support tracked symlinks or Git submodules. Prepare an explicit self-contained snapshot; no task was started and original files were preserved.');
}
function recordPath(directory, threadId, sourceRoot) {
  const normalizedRoot = process.platform === 'win32' ? sourceRoot.toLowerCase() : sourceRoot;
  // Keep Windows checkout paths below Git's internal path limit where
  // possible. Exact identity is still verified in the manifest, so even a
  // digest-prefix collision fails closed instead of sharing a workspace.
  return join(directory, createHash('sha256').update(JSON.stringify([threadId, normalizedRoot])).digest('hex').slice(0, 32));
}
function readRecord(path) {
  try {return JSON.parse(readFileSync(join(path, 'workspace.json'), 'utf8'));}
  catch {throw new Error(`Workspace isolation found an incomplete or unrecognized workspace at ${path}. It was preserved for inspection; do not reuse or remove it automatically.`);}
}
function validateRecord(record, {threadId, sourceRoot, recordDirectory}) {
  requireThreadId(threadId);
  if (record.version !== 1 || record.mode !== ISOLATION_MODE || record.thread_id !== threadId || !samePath(record.source_root ?? '', sourceRoot))
    throw new Error('Workspace isolation ownership does not match this conversation and source. Existing files were preserved.');
  const expectedRoot = join(recordDirectory, 'checkout');
  if (!samePath(record.worktree_root ?? '', expectedRoot) || !existsSync(expectedRoot) || !samePath(canonical(expectedRoot), expectedRoot))
    throw new Error('The isolated worktree was moved, removed, or redirected. Refusing to use another checkout.');
  const actualRoot = canonical(git(expectedRoot, ['rev-parse', '--show-toplevel']).trim());
  const actualCommon = canonical(git(expectedRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  if (!samePath(actualRoot, expectedRoot) || !samePath(actualCommon, record.common_dir ?? ''))
    throw new Error('The isolated worktree no longer points to its recorded Git repository. Refusing to run.');
  return record;
}

export function prepareWorkspace(config, {cwd, threadId, permission}) {
  requireThreadId(threadId);
  if (permission === 'danger-full-access')
    throw new Error('danger-full-access is incompatible with conversation workspace isolation. Use workspace-write or read-only; a Git worktree is not a security sandbox.');
  const sourceCwd = canonical(cwd);
  const directory = canonicalFuture(resolve(config.isolationRoot ?? join(dirname(config.database), 'workspaces')));
  if (inside(directory, sourceCwd)) throw new Error('A managed isolation directory cannot be used as a new source cwd. Pass the original source_cwd, or follow up with the existing agent.');
  const {root, common} = sourceInfo(sourceCwd);
  if (inside(root, directory)) throw new Error('The isolation directory must be outside the source Git checkout. No task was started.');
  const recordDirectory = recordPath(directory, threadId, root);
  let record;
  if (existsSync(recordDirectory)) {
    record = validateRecord(readRecord(recordDirectory), {threadId, sourceRoot: root, recordDirectory});
  } else {
    assertClean(root);
    let commit;
    try {commit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();}
    catch {throw new Error('Workspace isolation requires at least one committed Git snapshot. No files were changed.');}
    assertSupportedTree(root, commit);
    mkdirSync(directory, {recursive: true, mode: 0o700});
    // Atomic reservation also protects against two daemon processes. An
    // interrupted creation stays visible and is never silently overwritten.
    try {mkdirSync(recordDirectory, {mode: 0o700});}
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('This conversation workspace is being prepared by another request. Retry after that request finishes; no existing files were changed.');
      throw error;
    }
    const worktreeRoot = join(recordDirectory, 'checkout');
    const hooksDirectory = join(recordDirectory, 'empty-hooks');
    mkdirSync(hooksDirectory, {mode: 0o700});
    git(root, ['worktree', 'add', '--detach', worktreeRoot, commit], hooksDirectory);
    // Pin the initial snapshot and reject a concurrent source edit rather
    // than claim it was included. The newly created checkout is retained.
    assertClean(root);
    if (git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== commit)
      throw new Error(`The source HEAD changed while preparing isolation. The unstarted worktree at ${worktreeRoot} was preserved; retry with a stable source snapshot.`);
    record = {version: 1, mode: ISOLATION_MODE, thread_id: threadId, source_root: root, common_dir: common, worktree_root: worktreeRoot, base_commit: commit, created_at: new Date().toISOString()};
    writeFileSync(join(recordDirectory, 'workspace.json'), JSON.stringify(record, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    validateRecord(record, {threadId, sourceRoot: root, recordDirectory});
  }
  const workCwd = join(record.worktree_root, relative(root, sourceCwd));
  if (!existsSync(workCwd) || !statSync(workCwd).isDirectory() || !inside(record.worktree_root, canonical(workCwd)))
    throw new Error('The requested source subdirectory is absent or redirected in this conversation snapshot. Use the recorded snapshot or prepare an explicit new source snapshot.');
  return {cwd: workCwd, source_cwd: sourceCwd, isolation: {...record, record_directory: recordDirectory}};
}

export function assertWorkspaceOwner(config, agent, threadId) {
  if (!agent.isolation && !isolationEnabled(config)) return;
  requireThreadId(threadId);
  if (!agent.isolation)
    throw new Error('This pre-existing or external session has no conversation-isolated workspace. Its files and history were preserved. Start a new isolated agent instead of resuming it through this bridge.');
  if (agent.isolation.thread_id !== threadId)
    throw new Error('This agent belongs to another Codex conversation. It cannot be controlled from this conversation.');
}

export function validateAgentWorkspace(config, agent) {
  if (!agent.isolation && !isolationEnabled(config)) return;
  if (!agent.isolation) throw new Error('Refusing to run a legacy or external agent without a conversation-isolated workspace. Start a new isolated agent.');
  if (agent.permission === 'danger-full-access') throw new Error('danger-full-access is incompatible with conversation workspace isolation.');
  const record = agent.isolation;
  if (!record.record_directory || !isAbsolute(record.record_directory)) throw new Error('Missing isolated workspace ownership record.');
  const disk = validateRecord(readRecord(record.record_directory), {threadId: record.thread_id, sourceRoot: record.source_root, recordDirectory: record.record_directory});
  if (!samePath(disk.worktree_root, record.worktree_root) || !inside(disk.worktree_root, agent.cwd) || !existsSync(agent.cwd) || !inside(disk.worktree_root, canonical(agent.cwd)))
    throw new Error('Agent cwd no longer belongs to its recorded isolated workspace.');
}

export function isolatedPrompt(agent, task) {
  if (!agent.isolation) return task;
  return `Workspace isolation: this conversation works only in ${agent.cwd}. The source cwd ${agent.source_cwd} is a reference, not a write target. Remap source-path references in the task into this isolated checkout. Keep file edits inside ${agent.isolation.worktree_root}; do not edit the source checkout, other worktrees, or shared Git refs/configuration. This checkout began at ${agent.isolation.base_commit}; later source changes are not automatically imported. Return the isolated paths and changes for review; do not merge them back automatically.\n\n${task}`;
}
