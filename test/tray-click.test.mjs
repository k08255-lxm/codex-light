import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../desktop/MainWindow.cs', import.meta.url), 'utf8');
test('tray uses the NotifyIcon-specific left-click binding', () => {
  assert.match(source, /TrayInteraction\.BindRestore\(tray,RestoreFromTray\)/);
  assert.doesNotMatch(source, /tray\.(?:DoubleClick|MouseDoubleClick|Click|MouseClick)\s*\+=/);
});

test('right-click menu and restore lifecycle remain intact', () => {
  assert.match(source, /ContextMenuStrip=trayMenu/);
  const restore=source.slice(source.indexOf('public void RestoreFromTray()'), source.indexOf('void ShowFailure('));
  assert.match(restore, /if\(closing\|\|IsDisposed\)return/);
  assert.match(restore, /Show\(\)/);
  assert.match(restore, /WindowState==FormWindowState.Minimized/);
  assert.match(restore, /placement.WasMaximized\?FormWindowState.Maximized:FormWindowState.Normal/);
  assert.match(restore, /Activate\(\)/);
});
