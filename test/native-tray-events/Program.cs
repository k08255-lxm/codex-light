using System.Reflection;
using CodexLight.Desktop;
internal static class Program {
 [STAThread] static void Main() {
  using var icon=new NotifyIcon();int restored=0;
  TrayInteraction.BindRestore(icon,()=>restored++);
  var flags=BindingFlags.Instance|BindingFlags.NonPublic;
  var up=typeof(NotifyIcon).GetMethod("WmMouseUp",flags)??throw new Exception("NotifyIcon runtime changed");
  var down=typeof(NotifyIcon).GetMethod("WmMouseDown",flags)??throw new Exception("NotifyIcon runtime changed");
  up.Invoke(icon,[MouseButtons.Left]);
  if(restored!=1)throw new Exception("First left release must restore (runtime Clicks=0)");
  up.Invoke(icon,[MouseButtons.Right]);up.Invoke(icon,[MouseButtons.Middle]);
  if(restored!=1)throw new Exception("Non-left buttons restored window");
  down.Invoke(icon,[MouseButtons.Left,2]);up.Invoke(icon,[MouseButtons.Left]);
  if(restored!=1)throw new Exception("Double-click restored twice");
  up.Invoke(icon,[MouseButtons.Left]);
  if(restored!=2)throw new Exception("Subsequent click did not restore");
  using var caption=new TestCaption();
  _=caption.Handle;
  foreach(int message in new[]{0x00AE,0x00AF,0x0085})
   if(caption.Dispatch(message)!=IntPtr.Zero)throw new Exception("Native frame paint was not suppressed");
  caption.Dispatch(0x0086);
  caption.Dispatch(0x0086,(IntPtr)1);
  Console.WriteLine("PASS: real NotifyIcon mouse release, right/middle, double-click and repeat");
 }
}

internal sealed class TestCaption:CaptionWindow {
 internal IntPtr Dispatch(int message,IntPtr wparam=default) {
  var m=Message.Create(Handle,message,wparam,IntPtr.Zero);WndProc(ref m);return m.Result;
 }
}
