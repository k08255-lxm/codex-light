using System.Diagnostics;
using System.Security.Principal;
using System.Text.Json;
namespace CodexLight.Desktop;
internal static class WorkerProgram {
 static int Main(string[] args){
  string? output=null;
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
   var original=VelopackPackage.ReadInstalled(Path.Combine(r.Root,"current"));
   using var heldPackage=VelopackPackage.Validate(r.Package,r.Hash,original);
   if(File.Exists(receipt+".commit"))throw new InvalidOperationException("Premature commit marker.");
   CheckCancellation(receipt);
   WriteReady(receipt+".ready.json",r);
   var timer=Stopwatch.StartNew();
   while(true){if(WorkerPolicy.MayApply(Marker(receipt+".cancel"),Marker(receipt+".commit"),parent.HasExited,timer.Elapsed))break;Thread.Sleep(100);}
   var sid=WindowsIdentity.GetCurrent().User?.Value??throw new InvalidOperationException("Unknown Windows user.");
   using var mutex=new Mutex(false,"CodexLight.Desktop."+sid,new NamedWaitHandleOptions{CurrentUserOnly=true,CurrentSessionOnly=true});
   bool owned=false;
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
    using var update=Process.Start(start)??throw new InvalidOperationException("Updater did not start.");
    update.WaitForExit();WriteResult(output,update.ExitCode,"Updater exited; no application restart requested.");return update.ExitCode;
   }finally{if(owned)mutex.ReleaseMutex();}
  }catch(Exception e){if(output!=null)try{WriteResult(output,1,e.GetType().Name+": "+e.Message);}catch{}return 1;}
 }
 static void WriteReady(string path,ApplyReceipt r){WorkerPolicy.Plain(Path.GetDirectoryName(path)!);var temporary=path+".tmp";using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)){JsonSerializer.Serialize(stream,new{ready=true,parentPid=r.ParentPid,parentStartUtc=r.ParentStartUtc.ToString("O"),packageId=r.PackageId,hash=r.Hash});stream.Flush(true);}File.Move(temporary,path,false);}
 static bool Marker(string path){if(!File.Exists(path))return false;WorkerPolicy.Plain(path);if(new FileInfo(path).Length>1024)throw new InvalidDataException("Invalid handoff marker.");return true;}
 static void CheckCancellation(string receipt){if(Marker(receipt+".cancel"))throw new OperationCanceledException("Apply canceled by native caller.");}
 static void WriteResult(string path,int exitCode,string message){WorkerPolicy.Plain(Path.GetDirectoryName(path)!);using var stream=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read);JsonSerializer.Serialize(stream,new{exitCode,message,finishedUtc=DateTime.UtcNow.ToString("O")});stream.Flush(true);}
}



