using System.Runtime.InteropServices;
using CodexLight.Desktop;

internal static class NativeWindowTests {
 static int assertions;
 static void Check(bool value,string name){assertions++;if(!value)throw new InvalidOperationException(name);}
 [STAThread] static void Main(){
  System.Diagnostics.Trace.Listeners.Add(new System.Diagnostics.ConsoleTraceListener());
  Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
  var foreground=GetForegroundWindow();
  Geometry();Persistence();SessionEnd();Frame(foreground);
  Check(GetForegroundWindow()==foreground,"tests leave foreground unchanged");
  Console.WriteLine($"PASS {assertions} assertions; pure geometry/store and never-shown HWND messages only; no physical display/screenshot validation.");
 }
 static void SessionEnd(){
  var state=new WindowSessionEnd();int resourcesDisposed=0;
  void FormClosing(CloseReason reason){if(!state.DeferCleanup(reason))resourcesDisposed++;}
  Check(!state.QueryPending&&!state.Confirmed,"session initially normal");
  state.Observe(0x0011,IntPtr.Zero);FormClosing(CloseReason.WindowsShutDown);
  Check(state.QueryPending&&!state.Confirmed&&resourcesDisposed==0,"query saves state but retains resources");
  state.Observe(0x0016,IntPtr.Zero);
  Check(!state.QueryPending&&!state.Confirmed&&resourcesDisposed==0,"cancelled session retains resources");
  Check(!state.DeferCleanup(CloseReason.UserClosing),"normal close usable after cancelled shutdown");
  state.Observe(0x0011,IntPtr.Zero);FormClosing(CloseReason.WindowsShutDown);
  state.Observe(0x0016,(IntPtr)1);if(state.Confirmed)resourcesDisposed++;
  Check(!state.QueryPending&&state.Confirmed&&resourcesDisposed==1,"confirmed end permits disposal once");
  var noQuery=new WindowSessionEnd();noQuery.Observe(0x0016,(IntPtr)1);
  Check(noQuery.Confirmed,"confirmed end need not follow delivered query");
  using var form=new SessionProbe();var handle=form.Handle;
  Check(SendMessage(handle,0x0011,IntPtr.Zero,IntPtr.Zero)==(IntPtr)1,"WinForms query accepted without teardown");
  Check(!form.IsDisposed&&form.ReleaseCount==0,"WinForms query retains unshown resources");
  SendMessage(handle,0x0016,IntPtr.Zero,IntPtr.Zero);
  Check(!form.IsDisposed&&form.ReleaseCount==0,"WinForms cancelled query keeps form usable");
  Check(SendMessage(handle,0x0011,IntPtr.Zero,IntPtr.Zero)==(IntPtr)1,"WinForms accepts another query after cancel");
  SendMessage(handle,0x0016,(IntPtr)1,IntPtr.Zero);
  Check(form.IsDisposed&&form.ReleaseCount==1,"WinForms confirmed end performs actual disposal");
 }
 static void Geometry(){
  var left=new WindowMonitor("left",new Rectangle(-1920,0,1920,1040));
  var primary=new WindowMonitor("main",new Rectangle(0,40,2560,1400));
  var original=new WindowPlacement(1,new Rectangle(-1820,100,1200,800),left.WorkArea,"left",96,false);
  Check(original.IsValid,"valid state");
  Check(WindowPlacement.SelectMonitor(original,[primary,left])==left,"monitor identity before array order");
  Check(WindowPlacement.Restore(original,left,96,new Size(800,600))==original.NormalBounds,"same display exact restore");
  var scaled=WindowPlacement.Restore(original,left,144,new Size(800,600));
  Check(scaled==new Rectangle(-1800,0,1800,1040),"DPI dimensions scale and clamp");
  var removed=WindowPlacement.SelectMonitor(original,[primary]);
  Check(removed==primary,"removed monitor fallback");
  var moved=WindowPlacement.Restore(original,primary,96,new Size(800,600));
  Check(moved==new Rectangle(100,140,1200,800),"workarea relative relocation");
  var tiny=new WindowMonitor("tiny",new Rectangle(-600,-400,600,400));
  Check(WindowPlacement.Restore(original,tiny,192,new Size(800,600))==tiny.WorkArea,"small screen fully visible");
  var oversized=original with{NormalBounds=new Rectangle(int.MinValue,0,int.MaxValue,1)};
  Check(!oversized.IsValid,"reject extreme corrupted rectangle");
  Check(!(original with{Dpi=0}).IsValid,"reject zero DPI");
  Check(!(original with{Monitor=null!}).IsValid,"reject missing monitor");
  var normal=WindowPlacement.Capture(null,FormWindowState.Normal,original.NormalBounds,Rectangle.Empty,left,96)!;
  Check(normal.NormalBounds==original.NormalBounds&&!normal.Maximized,"normal capture");
  var max=WindowPlacement.Capture(normal,FormWindowState.Maximized,left.WorkArea,original.NormalBounds,left,96)!;
  Check(max.NormalBounds==original.NormalBounds&&max.Maximized,"maximized uses restore bounds");
  Check(ReferenceEquals(WindowPlacement.Capture(max,FormWindowState.Minimized,new Rectangle(-32000,-32000,160,28),Rectangle.Empty,left,96),max),"minimized cannot overwrite normal or maximized state");
  Check(ReferenceEquals(WindowPlacement.Capture(max,FormWindowState.Normal,Rectangle.Empty,Rectangle.Empty,left,96),max),"invalid transient bounds cannot overwrite state");
  for(int dpi=96;dpi<=240;dpi+=24){
   foreach(var screen in new[]{left,primary,tiny}){
    var result=WindowPlacement.Restore(original,screen,dpi,new Size(800,600));
    Check(screen.WorkArea.Contains(result),$"visible at DPI {dpi} on {screen.Name}");
   }
  }
 }
 static void Persistence(){
  string directory=Path.Combine(AppContext.BaseDirectory,"state-test-"+Guid.NewGuid().ToString("N"));
  Directory.CreateDirectory(directory);
  try{
   string path=Path.Combine(directory,"window-state.json");var store=new WindowPlacementStore(path);
   Check(store.Load()==null,"missing state defaults");
   var state=new WindowPlacement(1,new Rectangle(-1700,90,1000,700),new Rectangle(-1920,0,1920,1040),"left",144,true);
   Check(store.Save(state),"save state");Check(store.Load()==state,"JSON exact round trip");
   var updated=state with{NormalBounds=new Rectangle(100,150,1100,750),Maximized=false};
   Check(store.Save(updated)&&store.Load()==updated,"atomic replacement latest state");
   Check(Directory.GetFiles(directory).Length==1,"no temporary files remain");
   foreach(var corrupt in new[]{"{","null","{}","{\"Version\":999}",new string(' ',9000)}){
    File.WriteAllText(path,corrupt);Check(store.Load()==null,"corrupt state defaults: "+corrupt.Length);
   }
   File.WriteAllText(path,"old");Check(!store.Save(updated with{Dpi=0}),"invalid save rejected");
   Check(File.ReadAllText(path)=="old","invalid save leaves previous document");
   var badStore=new WindowPlacementStore(directory);Check(!badStore.Save(updated),"blocked path reports failure without crash");
   Check(Directory.GetFiles(directory).Length==1,"failed save removes temporary document");
  }finally{Directory.Delete(directory,true);}
 }
 static void Frame(IntPtr foreground){
  using var window=new FrameProbe{Bounds=new Rectangle(-2000,-2000,1100,800),MinimumSize=new Size(800,600)};
  var handle=window.Handle;Check(!window.Visible,"HWND remains unshown");Check(GetForegroundWindow()==foreground,"creating HWND does not activate");
  AssertCornerPreference(handle);
  AssertClientIsWholeWindow(handle);
  var windowRect=GetWindowRectangle(handle);
  foreach(bool light in new[]{false,true})foreach(string style in new[]{"codex","claude"}){
   window.Theme(light,style);
   for(int i=0;i<6;i++){
    Check(SendMessage(handle,0x0086,(IntPtr)(i%2),IntPtr.Zero)!=(IntPtr)0,"activation transition accepted");
    Check(SendMessage(handle,0x0085,(IntPtr)1,IntPtr.Zero)==IntPtr.Zero,"NC paint owned by client frame");
    SendMessage(handle,0x031E,IntPtr.Zero,IntPtr.Zero); // composition change on this HWND only
    SendMessage(handle,0x031A,IntPtr.Zero,IntPtr.Zero); // theme rebuild on this HWND only
    AssertCornerPreference(handle);
    AssertClientIsWholeWindow(handle);
    Check(GetWindowRectangle(handle)==windowRect,"frame lifecycle preserves geometry");
    Check(!window.Visible&&GetForegroundWindow()==foreground,"message cycle stays hidden and inactive");
   }
   using var image=new Bitmap(window.Width,window.Height);window.DrawToBitmap(image,window.ClientRectangle);
   Check(image.GetPixel(0,image.Height/2).ToArgb()==window.BackColor.ToArgb(),"client edge paints caption theme offscreen");
   Check(Hit(handle,windowRect.Left+1,windowRect.Top+1)==13,"top-left resize hit");
   Check(Hit(handle,windowRect.Right-1,windowRect.Bottom-1)==17,"bottom-right resize hit");
   Check(Hit(handle,windowRect.Left+windowRect.Width/2,windowRect.Top+window.DeviceDpi/4)==2,"caption drag hit");
   Check(Hit(handle,windowRect.Left+windowRect.Width/2,windowRect.Top+windowRect.Height/2)==1,"content hit");
  }
 }
 static void AssertCornerPreference(IntPtr hwnd){
  if(!OperatingSystem.IsWindowsVersionAtLeast(10,0,22000))return;
  int result=DwmGetWindowAttribute(hwnd,33,out int preference,sizeof(int));
  Check(result>=0,$"native corner preference readable: 0x{result:X8}");
  Check(preference==2,"DWM retains round-corner preference on unshown HWND");
 }
 static int Hit(IntPtr hwnd,int x,int y)=>SendMessage(hwnd,0x0084,IntPtr.Zero,(IntPtr)((y<<16)|(x&0xffff))).ToInt32();
 static void AssertClientIsWholeWindow(IntPtr hwnd){GetClientRect(hwnd,out var client);var full=GetWindowRectangle(hwnd);Check(client.Right==full.Width&&client.Bottom==full.Height,"no system frame inset");}
 static Rectangle GetWindowRectangle(IntPtr hwnd){GetWindowRect(hwnd,out var rect);return Rectangle.FromLTRB(rect.Left,rect.Top,rect.Right,rect.Bottom);}
 sealed class FrameProbe:CaptionWindow {internal void Theme(bool light,string style)=>SetCaptionTheme(light,style);}
 sealed class SessionProbe:Form {
  readonly WindowSessionEnd session=new();internal int ReleaseCount;
  protected override void WndProc(ref Message message){session.Observe(message.Msg,message.WParam);base.WndProc(ref message);}
  protected override void OnFormClosing(FormClosingEventArgs e){base.OnFormClosing(e);if(session.DeferCleanup(e.CloseReason))return;throw new InvalidOperationException("Unexpected interactive close in session test");}
  protected override void Dispose(bool disposing){if(disposing&&!IsDisposed)ReleaseCount++;base.Dispose(disposing);}
 }
 [StructLayout(LayoutKind.Sequential)]struct NativeRect{public int Left,Top,Right,Bottom;}
 [DllImport("dwmapi.dll")]static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out int value,int size);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern IntPtr SendMessage(IntPtr hwnd,int message,IntPtr wp,IntPtr lp);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr hwnd,out NativeRect rect);
 [DllImport("user32.dll")]static extern bool GetClientRect(IntPtr hwnd,out NativeRect rect);
}
