using System.Text.Json;

namespace CodexLight.Desktop;

// Physical desktop coordinates plus the DPI at which the normal bounds were
// captured. Maximized/minimized bounds are never persisted as normal geometry.
internal sealed record WindowPlacement(int Version, Rectangle NormalBounds, Rectangle WorkArea, string Monitor, int Dpi, bool Maximized) {
 internal bool IsValid=>Version==1&&ValidRect(NormalBounds)&&ValidRect(WorkArea)&&Dpi is >=48 and <=768&&Monitor is {Length:>0 and <=256};
 static bool ValidRect(Rectangle r)=>r.Width is >0 and <=100000&&r.Height is >0 and <=100000&&r.X is >=-1000000 and <=1000000&&r.Y is >=-1000000 and <=1000000;

 internal static WindowMonitor SelectMonitor(WindowPlacement state,IReadOnlyList<WindowMonitor> monitors){
  if(monitors.Count==0)throw new ArgumentException("At least one monitor is required",nameof(monitors));
  foreach(var monitor in monitors)if(monitor.Name==state.Monitor)return monitor;
  // A removed display may have negative coordinates. Prefer intersection, then
  // the nearest surviving display instead of assuming the primary is at 0,0.
  return monitors.OrderByDescending(m=>IntersectionArea(state.NormalBounds,m.WorkArea))
   .ThenBy(m=>DistanceSquared(state.NormalBounds,m.WorkArea)).First();
 }
 internal static Rectangle Restore(WindowPlacement state,WindowMonitor monitor,int targetDpi,Size minimum){
  double ratio=(double)targetDpi/state.Dpi;
  var work=monitor.WorkArea;
  int width=Math.Clamp((int)Math.Round(state.NormalBounds.Width*ratio),Math.Min(minimum.Width,work.Width),work.Width);
  int height=Math.Clamp((int)Math.Round(state.NormalBounds.Height*ratio),Math.Min(minimum.Height,work.Height),work.Height);
  int x=work.Left+(int)Math.Round((state.NormalBounds.Left-state.WorkArea.Left)*ratio);
  int y=work.Top+(int)Math.Round((state.NormalBounds.Top-state.WorkArea.Top)*ratio);
  return new Rectangle(Math.Clamp(x,work.Left,work.Right-width),Math.Clamp(y,work.Top,work.Bottom-height),width,height);
 }
 internal static WindowPlacement? Capture(WindowPlacement? previous,FormWindowState current,Rectangle bounds,Rectangle restoreBounds,WindowMonitor monitor,int dpi){
  if(current==FormWindowState.Minimized)return previous;
  var normal=current==FormWindowState.Maximized?restoreBounds:bounds;
  var candidate=new WindowPlacement(1,normal,monitor.WorkArea,monitor.Name,dpi,current==FormWindowState.Maximized);
  return candidate.IsValid?candidate:previous;
 }
 static long IntersectionArea(Rectangle a,Rectangle b){var r=Rectangle.Intersect(a,b);return (long)Math.Max(0,r.Width)*Math.Max(0,r.Height);}
 static double DistanceSquared(Rectangle a,Rectangle b){double dx=(double)a.X+a.Width/2d-b.X-b.Width/2d,dy=(double)a.Y+a.Height/2d-b.Y-b.Height/2d;return dx*dx+dy*dy;}
}

internal readonly record struct WindowMonitor(string Name,Rectangle WorkArea);

internal sealed class WindowPlacementStore {
 readonly string path;
 internal WindowPlacementStore(string path){this.path=path;}
 internal static WindowPlacementStore ForCurrentUser()=>new(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLight","window-state.json"));
 internal WindowPlacement? Load(){
  try{
   using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Delete);
   if(stream.Length is <=0 or >8192)return null;
   var state=JsonSerializer.Deserialize<WindowPlacement>(stream);
   return state?.IsValid==true?state:null;
  }catch(IOException){return null;}catch(UnauthorizedAccessException){return null;}catch(JsonException){return null;}
 }
 internal bool Save(WindowPlacement state){
  if(!state.IsValid)return false;
  string? temporary=null;
  try{
   string directory=Path.GetDirectoryName(path)!;Directory.CreateDirectory(directory);
   temporary=Path.Combine(directory,".window-state-"+Guid.NewGuid().ToString("N")+".tmp");
   using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)){
    JsonSerializer.Serialize(stream,state);stream.Flush(true);
   }
   // Same-directory rename replaces the old complete document in one operation.
   File.Move(temporary,path,true);temporary=null;return true;
  }catch(IOException error){System.Diagnostics.Trace.WriteLine("Window state not saved: "+error.Message);return false;}
  catch(UnauthorizedAccessException error){System.Diagnostics.Trace.WriteLine("Window state not saved: "+error.Message);return false;}
  finally{if(temporary!=null)try{File.Delete(temporary);}catch(IOException){}catch(UnauthorizedAccessException){}}
 }
}

internal sealed class WindowPlacementController:IDisposable {
 readonly Form window;
 readonly WindowPlacementStore store;
 readonly System.Windows.Forms.Timer saveTimer=new(){Interval=500};
 WindowPlacement? state;
 bool tracking;
 internal bool WasMaximized=>state?.Maximized==true;
 internal WindowPlacementController(Form window,WindowPlacementStore store){
  this.window=window;this.store=store;state=store.Load();
  saveTimer.Tick+=(_,_)=>Save();
  if(state!=null){
   var monitor=WindowPlacement.SelectMonitor(state,Monitors());
   window.StartPosition=FormStartPosition.Manual;
   // Move the unshown HWND to the target monitor before the final DPI conversion.
   window.Bounds=WindowPlacement.Restore(state,monitor,state.Dpi,window.MinimumSize);
  }
 }
 static WindowMonitor[] Monitors()=>Screen.AllScreens.Select(s=>new WindowMonitor(s.DeviceName,s.WorkingArea)).ToArray();
 internal void Restore(){
  var monitors=Monitors();
  var monitor=state!=null?WindowPlacement.SelectMonitor(state,monitors):monitors.First(m=>m.Name==Screen.FromRectangle(window.Bounds).DeviceName);
  window.MinimumSize=new Size(Math.Min(window.MinimumSize.Width,monitor.WorkArea.Width),Math.Min(window.MinimumSize.Height,monitor.WorkArea.Height));
  if(state!=null){
   // OnLoad runs after WinForms' initial autoscaling, on the selected monitor.
   // Reapply once at its actual HWND DPI, avoiding a second startup scale.
   window.Bounds=WindowPlacement.Restore(state,monitor,window.DeviceDpi,window.MinimumSize);
   if(state.Maximized)window.WindowState=FormWindowState.Maximized;
  }else{
   var defaults=new WindowPlacement(1,window.Bounds,monitor.WorkArea,monitor.Name,window.DeviceDpi,false);
   window.Bounds=WindowPlacement.Restore(defaults,monitor,window.DeviceDpi,window.MinimumSize);
  }
  tracking=true;Capture();
 }
 internal void Capture(){
  if(!tracking||!window.Visible||window.WindowState==FormWindowState.Minimized)return;
  Rectangle normal=window.WindowState==FormWindowState.Normal?window.Bounds:window.RestoreBounds;
  if(normal.Width<=0||normal.Height<=0)return;
  var screen=Screen.FromRectangle(normal);
  state=WindowPlacement.Capture(state,window.WindowState,window.Bounds,window.RestoreBounds,new WindowMonitor(screen.DeviceName,screen.WorkingArea),window.DeviceDpi);
  saveTimer.Stop();saveTimer.Start();
 }
 internal void Save(){saveTimer.Stop();if(state!=null)store.Save(state);}
 public void Dispose(){saveTimer.Dispose();}
}
