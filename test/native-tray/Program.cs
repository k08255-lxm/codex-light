using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using CodexLight.Bootstrap;
using CodexLight.Desktop;

internal static class NativeTrayTests {
 const BindingFlags Instance=BindingFlags.Instance|BindingFlags.NonPublic;
 static int assertions;
 static void Check(bool value,string message){assertions++;if(!value)throw new InvalidOperationException(message);}
 static FieldInfo Field(string name)=>typeof(MainWindow).GetField(name,Instance)!;
 static void Call(MainWindow window,string method,params object[] args)=>typeof(MainWindow).GetMethod(method,Instance)!.Invoke(window,args);
 static NotifyIcon Tray(MainWindow window)=>(NotifyIcon)Field("tray").GetValue(window)!;
 [STAThread] static void Main(string[] args){
  Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
  if(args.Length==2&&args[0]=="--restart-manager-child"){RestartManagerChild(args[1]);return;}
  string directory=Path.Combine(AppContext.BaseDirectory,"tray-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
  try{
   using var window=CreateWindow(directory);
   window.Show();Application.DoEvents();
   Check(Tray(window).Visible,"foreground window has tray immediately after load");
   Check(Field("backend").GetValue(window)==null,"test never starts backend");
   var tray=Tray(window);Call(window,"ShowTray");Check(ReferenceEquals(tray,Tray(window)),"repeated show reuses icon");
   window.Hide();window.RestoreFromTray();
   Check(window.Visible&&Tray(window).Visible,"restore retains tray icon");
   window.WindowState=FormWindowState.Minimized;window.RestoreFromTray();
   Check(window.WindowState==FormWindowState.Normal&&Tray(window).Visible,"minimized restore retains icon");
   // Use this test runner as a live backend sentinel; shutdown is never invoked while assigned.
   using var sentinel=Process.GetCurrentProcess();Field("backend").SetValue(window,sentinel);
   try{Call(window,"MoveToTray");Check(!window.Visible&&Tray(window).Visible,"move hides window and retains icon");}
   finally{Field("backend").SetValue(window,null);}
   Call(window,"ShowFailure","test failure");Check(window.Visible&&Tray(window).Visible,"hidden failure restores window and retains icon");
   Call(window,"MoveToTray");Check(window.Visible&&Tray(window).Visible,"failed window cannot hide to tray");
   ((ToolStripMenuItem)tray.ContextMenuStrip!.Items[2]).PerformClick();
   Application.DoEvents();
   Check(window.IsDisposed,"tray exit closes test window without choice dialog");
   Check(Field("tray").GetValue(window)==null&&Field("trayMenu").GetValue(window)==null&&Field("trayIcon").GetValue(window)==null,"exit disposes icon menu and cloned icon");
   window.Dispose();Check(Field("tray").GetValue(window)==null,"repeated disposal is safe");
   RestartManager(directory).GetAwaiter().GetResult();
   Console.WriteLine($"PASS {assertions} assertions; native tray lifecycle and owned-child real Restart Manager shutdown; no app backend or WebView startup.");
  }finally{Directory.Delete(directory,true);}
 }
 static MainWindow CreateWindow(string directory){
  var window=new MainWindow(false){Opacity=0,ShowInTaskbar=false,Enabled=false};
  // Isolate persistence before load/close; suppress the real startup event entirely.
  ((WindowPlacementController)Field("placement").GetValue(window)!).Dispose();
  Field("placement").SetValue(window,new WindowPlacementController(window,new WindowPlacementStore(Path.Combine(directory,"window-state.json"))));
  var events=(EventHandlerList)typeof(Component).GetProperty("Events",Instance)!.GetValue(window)!;
  var shownKey=typeof(Form).GetFields(BindingFlags.Static|BindingFlags.NonPublic).Single(field=>field.Name.Equals("s_shownEvent",StringComparison.OrdinalIgnoreCase)).GetValue(null)!;
  if(events[shownKey] is Delegate startup)events.RemoveHandler(shownKey,startup);
  return window;
 }
 static void RestartManagerChild(string directory){
  using var window=CreateWindow(directory);
  var messages=new List<string>();using var observer=new ShutdownObserver(messages);
  window.HandleCreated+=(_,_)=>observer.AssignHandle(window.Handle);
  if(window.IsHandleCreated)observer.AssignHandle(window.Handle);
  window.FormClosing+=(_,e)=>messages.Add($"Closing:{e.CloseReason}:cancel={e.Cancel}");
  window.FormClosed+=(_,e)=>messages.Add($"Closed:{e.CloseReason}");
  bool watchdogTriggered=false;
  using var watchdog=new System.Windows.Forms.Timer{Interval=20000};
  watchdog.Tick+=(_,_)=>{watchdogTriggered=true;watchdog.Stop();window.Dispose();Application.ExitThread();};
  window.Shown+=(_,_)=>{
   using var sentinel=Process.GetCurrentProcess();Field("backend").SetValue(window,sentinel);
   try{Call(window,"MoveToTray");}finally{Field("backend").SetValue(window,null);}
   if(window.Visible||!Tray(window).Visible||Field("backend").GetValue(window)!=null)throw new InvalidOperationException("child must be hidden with tray and no backend");
   watchdog.Start();Console.WriteLine("READY");Console.Out.Flush();
  };
  Application.Run(window);
  watchdog.Stop();
  var session=(WindowSessionEnd)Field("sessionEnd").GetValue(window)!;
  bool disposed=window.IsDisposed&&Field("tray").GetValue(window)==null&&Field("trayMenu").GetValue(window)==null&&Field("trayIcon").GetValue(window)==null;
  Console.WriteLine($"RESULT disposed={disposed} confirmed={session.Confirmed} watchdog={watchdogTriggered}");Console.Out.Flush();
  Console.WriteLine("MESSAGES "+string.Join(",",messages));Console.Out.Flush();
  // Restart Manager may end the WinForms message loop without delivering session-end
  // messages to this particular HWND. The contract is graceful exit and real cleanup.
  Environment.ExitCode=disposed&&!watchdogTriggered?0:2;
 }
 sealed class ShutdownObserver(List<string> messages):NativeWindow,IDisposable {
  protected override void WndProc(ref Message message){if(message.Msg is 0x0010 or 0x0011 or 0x0016)messages.Add($"{message.Msg:X4}:{message.WParam}:{message.LParam}");base.WndProc(ref message);}
  public void Dispose(){if(Handle!=IntPtr.Zero)ReleaseHandle();}
 }
 static async Task RestartManager(string directory){
  string executable=Path.GetFullPath(Path.ChangeExtension(typeof(NativeTrayTests).Assembly.Location,".exe"));
  Check(Path.IsPathFullyQualified(executable)&&File.Exists(executable),"child uses absolute dedicated GUI test apphost");
  var start=new ProcessStartInfo(executable){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
  start.ArgumentList.Add("--restart-manager-child");start.ArgumentList.Add(directory);
  using var child=Process.Start(start)??throw new InvalidOperationException("Could not start owned test child");
  var stderr=child.StandardError.ReadToEndAsync();
  try{
   string? ready=await child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(8));
   Check(ready=="READY","owned child ready while hidden to tray");
   var identity=new RunningAppProcess(child.Id,child.StartTime.ToUniversalTime().ToFileTimeUtc(),child.MainModule!.FileName,child.SessionId);
   Check(identity.Id!=Environment.ProcessId&&identity.Created>0,"shutdown target is owned child with creation time");
   Check(string.Equals(Path.GetFullPath(identity.Executable),executable,StringComparison.OrdinalIgnoreCase),"owned child executable matches launched test apphost");
   Check(identity.Session==Process.GetCurrentProcess().SessionId,"owned child is in this test session");
   using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(15));
   await new WindowsRunningApplicationSystem().RequestShutdownAsync(new[]{identity},timeout.Token);
   await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
   string output=await child.StandardOutput.ReadToEndAsync(),errors=await stderr;
   Check(child.ExitCode==0,$"real Restart Manager child exit {child.ExitCode}; stdout={output}; stderr={errors}");
   Check(output.Contains("RESULT disposed=True",StringComparison.Ordinal)&&output.Contains("watchdog=False",StringComparison.Ordinal),"Restart Manager disposes hidden MainWindow before watchdog");
   Console.WriteLine("Restart Manager owned-child evidence: "+output.Trim().Replace(Environment.NewLine,"; "));
  }finally{
   // Never terminate any process. Only this owned fixture may self-close on its watchdog.
   if(!child.HasExited)await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(25));
  }
 }
}
