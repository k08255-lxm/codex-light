using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
namespace CodexLight.Desktop;
// Stages an out-of-process worker. It does not apply updates or stop any process itself.
internal static class VelopackApplyLauncher {
 static readonly string[] WorkerFiles={"CodexLight.UpdateWorker.exe","CodexLight.UpdateWorker.dll","CodexLight.UpdateWorker.deps.json","CodexLight.UpdateWorker.runtimeconfig.json"};
 internal static bool Available {get{try{_ = VelopackPackage.ReadInstalled(AppContext.BaseDirectory);return WorkerFiles.All(name=>File.Exists(Path.Combine(AppContext.BaseDirectory,"update-worker",name)));}catch{return false;}}}
 internal static async Task<StagedApply> StageAsync(string file,string hash) {
  var installed=VelopackPackage.ReadInstalled(AppContext.BaseDirectory);
  using var package=VelopackPackage.Validate(file,hash,installed);
  var directory=Path.Combine(installed.DataRoot,"Updates","worker-"+Guid.NewGuid().ToString("N"));
  for(string? p=Path.GetDirectoryName(directory);p!=null;p=Path.GetDirectoryName(p))if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("Unsafe worker cache.");
  Directory.CreateDirectory(directory);
  foreach(string name in WorkerFiles){var source=Path.Combine(installed.CurrentDirectory,"update-worker",name);for(string? check=source;check!=null;check=Path.GetDirectoryName(check))if((File.GetAttributes(check)&FileAttributes.ReparsePoint)!=0)throw new IOException("Unsafe worker file.");var destination=Path.Combine(directory,name);File.Copy(source,destination,false);using var a=File.OpenRead(source);using var b=File.OpenRead(destination);if(!SHA256.HashData(a).SequenceEqual(SHA256.HashData(b)))throw new IOException("Worker copy mismatch.");}
  using var self=Process.GetCurrentProcess();
  var receipts=Path.Combine(installed.DataRoot,"Updates","Apply");Directory.CreateDirectory(receipts);
  if((File.GetAttributes(receipts)&FileAttributes.ReparsePoint)!=0)throw new IOException("Unsafe receipt directory.");
  var receipt=Path.Combine(receipts,Guid.NewGuid().ToString("N")+".json");
  File.WriteAllText(receipt,JsonSerializer.Serialize(new{root=installed.ProgramRoot,package=package.Path,hash=package.Sha256,parentPid=self.Id,parentStartUtc=self.StartTime.ToUniversalTime().ToString("O"),packageId=VelopackPackage.PackageId}));
  var start=new ProcessStartInfo(Path.Combine(directory,WorkerFiles[0])){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=directory};start.ArgumentList.Add("--receipt");start.ArgumentList.Add(receipt);
  var process=Process.Start(start);if(process==null)throw new AppUpdateLaunchUnknownException();
  var staged=new StagedApply(receipt,process,hash,self.Id,self.StartTime.ToUniversalTime());
  try{await staged.WaitForReadyAsync();return staged;}catch{staged.Dispose();throw;}
 }
 internal sealed class StagedApply : IDisposable {
  readonly string receipt,hash;readonly int parentPid;readonly DateTime parentStartUtc;readonly Process worker;
  bool committed,disposed;
  internal StagedApply(string receipt,Process worker,string hash,int parentPid,DateTime parentStartUtc){this.receipt=receipt;this.worker=worker;this.hash=hash;this.parentPid=parentPid;this.parentStartUtc=parentStartUtc;}
  static void Plain(string path){for(string? p=path;p!=null;p=Path.GetDirectoryName(p))if((File.Exists(p)||Directory.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("Unsafe worker handshake.");}
  internal async Task WaitForReadyAsync(){
   var deadline=DateTime.UtcNow.AddSeconds(15);string ready=receipt+".ready.json";
   while(DateTime.UtcNow<deadline){
    if(worker.HasExited)throw new IOException("Update worker exited before readiness.");
    if(File.Exists(ready)){
     Plain(ready);using var input=File.Open(ready,FileMode.Open,FileAccess.Read,FileShare.Read);
     if(input.Length>4096)throw new InvalidDataException("Oversized readiness acknowledgement.");
     using var parsed=JsonDocument.Parse(input);var r=parsed.RootElement;
     if(r.EnumerateObject().Count()!=5||!r.GetProperty("ready").GetBoolean()||r.GetProperty("parentPid").GetInt32()!=parentPid||r.GetProperty("parentStartUtc").GetDateTime()!=parentStartUtc||r.GetProperty("packageId").GetString()!=VelopackPackage.PackageId||r.GetProperty("hash").GetString()!=hash)throw new InvalidDataException("Unmatched worker readiness.");
     return;
    }
    await Task.Delay(50);
   }
   throw new TimeoutException("Update worker readiness timed out.");
  }
  internal void Commit(){if(disposed||committed||worker.HasExited||File.Exists(receipt+".cancel"))throw new IOException("Update worker is no longer ready.");WriteMarker(receipt+".commit");committed=true;}
  internal void Cancel(){if(disposed)return;WriteMarker(receipt+".cancel");committed=false;}
  static void WriteMarker(string path){Plain(path);try{using var stream=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read);stream.WriteByte(1);stream.Flush(true);}catch(IOException)when(File.Exists(path)){Plain(path);}}
  public void Dispose(){if(disposed)return;try{if(!committed)Cancel();}finally{disposed=true;worker.Dispose();}}

 }
}
