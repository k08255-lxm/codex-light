using System.Text.Json;

namespace CodexLight.Desktop;

internal sealed class DesktopCompanion(Form main,Action<string> open,Func<int,bool> requestSize) : IDisposable {
 CompanionWindow? window;
 Point? position;

 internal void Receive(string json) {
  if (!CompanionState.TryRead(json,out var next)) return;
  if (next==null) {Dispose();return;}
  if (window!=null) {window.Update(next);return;}
  // An owned window would disappear when the main window minimizes or moves to the tray.
  window=new CompanionWindow(next,open,requestSize);
  window.Closed+=(_,_)=>window=null;
  var monitor=position is {} saved?Screen.FromPoint(saved):Screen.FromHandle(main.Handle);
  window.ShowNear(monitor.WorkingArea,position);
 }
 internal void Disconnected() => window?.Disconnected();
 internal void SizeResult(string json) {
  if(window==null)return;
  using var doc=JsonDocument.Parse(json);
  var root=doc.RootElement;
  if(root.TryGetProperty("size",out var size) && size.ValueKind==JsonValueKind.Number && size.TryGetInt32(out var percent) &&
     root.TryGetProperty("saved",out var saved) && saved.ValueKind is JsonValueKind.True or JsonValueKind.False)
   window.SizeResult(percent,saved.GetBoolean());
 }
 public void Dispose() {
  if (window==null) return;
  if (window.IsVisible) position=window.Position;
  window.Close();
 }
}
