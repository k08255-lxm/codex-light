namespace CodexLight.Desktop;

internal sealed class DesktopCompanion(Form main,Action<string> open) : IDisposable {
 CompanionWindow? window;
 Point? position;

 internal void Receive(string json) {
  if (!CompanionState.TryRead(json,out var next)) return;
  if (next==null) {Dispose();return;}
  if (window!=null) {window.Update(next);return;}
  // An owned window would disappear when the main window minimizes or moves to the tray.
  window=new CompanionWindow(next,open);
  window.Closed+=(_,_)=>window=null;
  var monitor=position is {} saved?Screen.FromPoint(saved):Screen.FromHandle(main.Handle);
  window.ShowNear(monitor.WorkingArea,position);
 }
 internal void Disconnected() => window?.Disconnected();
 public void Dispose() {
  if (window==null) return;
  if (window.IsVisible) position=window.Position;
  window.Close();
 }
}
