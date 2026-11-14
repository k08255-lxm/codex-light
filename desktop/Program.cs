using System.Security.Principal;
namespace CodexLight.Desktop;
internal static class Program {
 static CodexLight.Shared.InstallMaintenance? AcquireMaintenance(){try{var lease=CodexLight.Shared.InstallMaintenance.Acquire(AppContext.BaseDirectory);if(File.Exists(Path.Combine(AppContext.BaseDirectory,"CodexLight.upgrade-journal.json"))||File.Exists(Path.Combine(AppContext.BaseDirectory,"CodexLight.upgrade-context.json"))){lease.Dispose();MessageBox.Show("此安装有未结束维护记录，请使用原安装包选择恢复或完成维护。不会启动后台。","码舱 CodeCang");return null;}return lease;}catch(Exception){MessageBox.Show("此安装正在运行或维护，请先正常关闭现有程序后重试。","码舱 CodeCang");return null;}}
 [STAThread] static void Main(string[] args) {
  if(args.Length==1&&args[0]=="--backend-health-check"){Environment.ExitCode=BackendHealth.RunAsync().GetAwaiter().GetResult();return;}
#if VELOPACK_PROTOTYPE
  // Opt-in packaging prototype only. Hooks must exit before UI or production wake/mutex handling.
  // Explicit user-directed updates only; never apply a staged update merely on startup.
  Velopack.VelopackApp.Build().SetArgs(args).SetAutoApplyOnStartup(false).Run();
  // Migration staging is not a health check and must not initialize user state.
  if(args.Length==1 && args[0]=="--migration-staged")return;
#endif
  ApplicationConfiguration.Initialize();
  var sid=WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("Windows user SID unavailable");
  var scope=new NamedWaitHandleOptions{CurrentUserOnly=true,CurrentSessionOnly=true};
  // Create the wake event before the mutex so a simultaneous second launch cannot miss it.
  using var wake=new EventWaitHandle(false,EventResetMode.AutoReset,"CodexLight.Desktop.Wake."+sid,scope);
  using var mutex=new Mutex(true,"CodexLight.Desktop."+sid,scope,out bool first);
  if(!first){wake.Set();return;}
  try {
   using var maintenance=AcquireMaintenance();if(maintenance==null)return;
   using var window=new MainWindow(args.Contains("--demo"));
   RegisteredWaitHandle? registration=null;
   window.HandleCreated+=(_,_)=>registration??=ThreadPool.RegisterWaitForSingleObject(wake,(_,_)=>{
    try{if(!window.IsDisposed&&window.IsHandleCreated)window.BeginInvoke((Action)window.RestoreFromTray);}catch(InvalidOperationException){}
   },null,Timeout.Infinite,false);
   try{Application.Run(window);}finally{registration?.Unregister(null);}
  }
  finally { mutex.ReleaseMutex(); }
 }
}
