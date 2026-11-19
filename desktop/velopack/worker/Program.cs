using System.Diagnostics;
using System.Security.Principal;
using System.Text.Json;
namespace CodexLight.Desktop;
internal static class WorkerProgram {
 static int Main(string[] args){
  string? output=null;
  bool parentExited=false;
  BootstrapProgress? progress=null;
  try{
   var local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
   var receipt=WorkerPolicy.ReceiptPath(args,local);WorkerPolicy.Plain(receipt);
   using var input=File.Open(receipt,FileMode.Open,FileAccess.Read,FileShare.Read);
   if(input.Length>16384)throw new InvalidDataException("Receipt too large.");
   using var reader=new StreamReader(input);var r=WorkerPolicy.Parse(reader.ReadToEnd());output=receipt+".result.json";
   WorkerPolicy.CheckWorker(Environment.ProcessPath??throw new InvalidDataException("Unknown worker executable."),r.Root);
   if(r.ParentPid==Environment.ProcessId)throw new InvalidDataException("Worker cannot be its own parent.");
   using var parent=Process.GetProcessById(r.ParentPid);
   if(parent.StartTime.ToUniversalTime()!=r.ParentStartUtc||parent.HasExited)throw new InvalidOperationException("Parent absent or PID reused before readiness.");
#if !BOOTSTRAP
   progress=BootstrapProgress.Start();
   progress.Report("正在校验下载的更新包…");
#endif
   var original=VelopackPackage.ReadInstalled(Path.Combine(r.Root,"current"));
#if BOOTSTRAP
   string Pin(string name)=>typeof(WorkerProgram).Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyMetadataAttribute),false).Cast<System.Reflection.AssemblyMetadataAttribute>().Single(a=>a.Key==name).Value??"";
   using var heldPackage=VelopackPackage.ValidateRepair(r.Package,r.Hash,original,Pin("RepairVersion"),Pin("RepairSha256"));
   BootstrapPolicy.CheckTarget(r.Root,local,heldPackage.Version,heldPackage.Sha256,Pin("RepairVersion"),Pin("RepairSha256"));
#else
   using var heldPackage=VelopackPackage.Validate(r.Package,r.Hash,original);
#endif
   if(File.Exists(receipt+".commit"))throw new InvalidOperationException("Premature commit marker.");
   CheckCancellation(receipt);
   // Probe the scoped API while the host is still alive. Holders are expected
   // here; a full empty-holder check still runs after the committed exit.
   _ = WorkerProcesses.Holders(WorkerProcesses.InstalledResources(r.Root));
#if !BOOTSTRAP
   progress.Report($"正在等待码舱退出，准备安装 v{heldPackage.Version}…");
#endif
   WriteReady(receipt+".ready.json",r);
   var timer=Stopwatch.StartNew();
   while(true){
    parentExited=parent.HasExited;
    if(WorkerPolicy.MayApply(Marker(receipt+".cancel"),Marker(receipt+".commit"),parentExited,timer.Elapsed))break;
    Thread.Sleep(100);
   }
   progress??=BootstrapProgress.Start();
   progress.Report("正在检查更新条件…");
   var sid=WindowsIdentity.GetCurrent().User?.Value??throw new InvalidOperationException("Unknown Windows user.");
   using var mutex=new Mutex(false,"CodexLight.Desktop."+sid,new NamedWaitHandleOptions{CurrentUserOnly=true,CurrentSessionOnly=true});
   bool owned=false;
   int exitCode;
   try{
    try{owned=mutex.WaitOne(0);}catch(AbandonedMutexException){owned=true;}
    if(!owned)throw new InvalidOperationException("Desktop still running.");
    using var rootLock=CodexLight.Shared.InstallMaintenance.Acquire(r.Root);
    using var currentLock=CodexLight.Shared.InstallMaintenance.Acquire(Path.Combine(r.Root,"current"));
    var identity=VelopackPackage.ReadInstalled(Path.Combine(r.Root,"current"));
    if(identity!=original)throw new InvalidDataException("Installed identity changed during handoff.");
    WorkerProcesses.EnsureNoInstalledProcesses(r.Root);CheckCancellation(receipt);
    var start=new ProcessStartInfo(identity.UpdaterPath){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=r.Root};
    foreach(var arg in new[]{"--silent","--rootDir",r.Root,"apply","--package",heldPackage.Path,"--norestart"})start.ArgumentList.Add(arg);
    progress.Report($"正在安装 v{heldPackage.Version}…");
    using var update=Process.Start(start)??throw new InvalidOperationException("Updater did not start.");
    update.WaitForExit();
    exitCode=update.ExitCode;
    if(exitCode==0){
     progress.Report("正在校验安装文件…");
     BootstrapPolicy.VerifyApplied(heldPackage,progress.ReportVerification);
    }
    var shortcutResults=exitCode==0?ShortcutBrandMigration.RunInstalled(heldPackage.Installed.CurrentDirectory):Array.Empty<string>();
    WriteResult(output,exitCode,"Updater exited; no application restart requested. "+string.Join("; ",shortcutResults));
   }finally{if(owned)mutex.ReleaseMutex();}
   progress.Complete(exitCode==0,exitCode==0
    ? $"v{heldPackage.Version} 已安装并校验。可以从开始菜单重新打开码舱 CodeCang。"
    : $"安装程序返回代码 {exitCode}。诊断文件：{output}");
   progress.WaitForClose();
   return exitCode;
  }catch(Exception e){
   string detail=e.Message;
   if(output!=null){
    try{WriteResult(output,1,e.GetType().Name+": "+e.Message);detail+="\r\n诊断文件："+output;}
    catch(Exception writeError)when(writeError is IOException or UnauthorizedAccessException or InvalidDataException){detail+="\r\n无法保存诊断文件："+writeError.Message;}
   }
   // The caller owns explicit cancellation feedback, even if it subsequently exits.
   if((parentExited||progress!=null)&&e is not OperationCanceledException){
    if(progress==null)Notify("更新未完成："+detail,true);
    else{progress.Complete(false,detail);progress.WaitForClose();}
   }
   return 1;
  }finally{progress?.Dispose();}
 }
 [System.Runtime.InteropServices.DllImport("user32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
 static extern int MessageBoxW(IntPtr owner,string text,string caption,uint type);
 static void Notify(string message,bool failure){try{MessageBoxW(IntPtr.Zero,message,"码舱 CodeCang 更新",failure?0x10u:0x40u);}catch{}}
 static void WriteReady(string path,ApplyReceipt r){WorkerPolicy.Plain(Path.GetDirectoryName(path)!);var temporary=path+".tmp";using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)){JsonSerializer.Serialize(stream,new{ready=true,parentPid=r.ParentPid,parentStartUtc=r.ParentStartUtc.ToString("O"),packageId=r.PackageId,hash=r.Hash});stream.Flush(true);}File.Move(temporary,path,false);}
 static bool Marker(string path){if(!File.Exists(path))return false;WorkerPolicy.Plain(path);if(new FileInfo(path).Length>1024)throw new InvalidDataException("Invalid handoff marker.");return true;}
 static void CheckCancellation(string receipt){if(Marker(receipt+".cancel"))throw new OperationCanceledException("Apply canceled by native caller.");}
 static void WriteResult(string path,int exitCode,string message){WorkerPolicy.Plain(Path.GetDirectoryName(path)!);using var stream=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read);JsonSerializer.Serialize(stream,new{exitCode,message,finishedUtc=DateTime.UtcNow.ToString("O")});stream.Flush(true);}
}



