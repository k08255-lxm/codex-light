import {DatabaseSync} from 'node:sqlite';
import {toNamespacedPath} from 'node:path';

// SQLite's Windows VFS otherwise fails beyond MAX_PATH, even though Node's
// filesystem APIs can create the same directory. Keep memory databases intact.
export function openDatabase(path, options = {}) {
  const filename = process.platform === 'win32' && typeof path === 'string' && path !== ':memory:' && path !== ''
    ? toNamespacedPath(path) : path;
  return new DatabaseSync(filename, options);
}
