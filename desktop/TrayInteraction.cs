namespace CodexLight.Desktop;

internal static class TrayInteraction {
 internal static void BindRestore(NotifyIcon tray,Action restore) {
  // NotifyIcon.MouseClick reports Clicks=0; it already suppresses the second
  // release of a double-click. Only discriminate the mouse button here.
  tray.MouseClick+=(_,e)=>{if(e.Button==MouseButtons.Left)restore();};
 }
}
