using System.Diagnostics;
using System.Text.Json;
using CodexLight.Desktop;
int checks=0;void Check(bool ok,string name){checks++;if(!ok)throw new Exception(name);}
using(var empty=new ChildJob()){Check(empty.IsEmpty,"new job is empty");empty.Dispose();Check(!empty.IsEmpty,"closed job cannot prove drain");}
string root=Path.Combine(Path.GetTempPath(),"codex-light-host-safety-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
string hash=new('a',64);using var self=Process.GetCurrentProcess();var time=self.StartTime.ToUniversalTime();
string Receipt()=>Path.Combine(root,Guid.NewGuid().ToString("N")+".json");
void Ready(string receipt,string digest){File.WriteAllText(receipt+".ready.json",JsonSerializer.Serialize(new{ready=true,parentPid=self.Id,parentStartUtc=time.ToString("O"),packageId=VelopackPackage.PackageId,hash=digest}));}
var path=Receipt();Ready(path,hash);
using(var stage=new VelopackApplyLauncher.StagedApply(path,Process.GetCurrentProcess(),hash,self.Id,time)){await stage.WaitForReadyAsync();stage.Cancel();Check(File.Exists(path+".cancel"),"cancel marker durable");bool rejected=false;try{stage.Commit();}catch(IOException){rejected=true;}Check(rejected&&!File.Exists(path+".commit"),"cancel cannot be committed");}
path=Receipt();Ready(path,hash);using(var stage=new VelopackApplyLauncher.StagedApply(path,Process.GetCurrentProcess(),hash,self.Id,time)){await stage.WaitForReadyAsync();}Check(File.Exists(path+".cancel"),"uncommitted dispose cancels");
path=Receipt();Ready(path,hash);using(var stage=new VelopackApplyLauncher.StagedApply(path,Process.GetCurrentProcess(),hash,self.Id,time)){await stage.WaitForReadyAsync();stage.Commit();Check(File.Exists(path+".commit"),"explicit commit marker");}Check(!File.Exists(path+".cancel"),"successful commit retained");
path=Receipt();Ready(path,new string('b',64));bool bad=false;using(var stage=new VelopackApplyLauncher.StagedApply(path,Process.GetCurrentProcess(),hash,self.Id,time)){try{await stage.WaitForReadyAsync();}catch(InvalidDataException){bad=true;}}Check(bad&&File.Exists(path+".cancel"),"bad readiness canceled");
var source=File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,"../../../../../MainWindow.cs")));
var start=source.IndexOf(" async Task QuitForVerifiedUpdateAsync",StringComparison.Ordinal);var end=source.IndexOf(" async Task WriteHostAsync",start,StringComparison.Ordinal);var quit=source[start..end];
Check(quit.Contains("while(job!=null&&!job.IsEmpty"),"descendant drain required");Check(quit.IndexOf("job=null",StringComparison.Ordinal)<quit.IndexOf("staged.Commit()",StringComparison.Ordinal),"empty job disposed before commit");Check(quit.Contains("staged.Cancel()"),"failed shutdown cancels worker");Check(source.Contains("!updateShutdownAttempted&&stopTask==null"),"Exited auto-kill disarmed during update");Check(source.Contains("!IsDisposed&&!updateShutdownAttempted"),"EOF auto-kill disarmed during update");
Console.WriteLine($"PASS {checks} host safety checks; no app/backend/task process started. Fixtures: {root}");
namespace CodexLight.Desktop {
 internal sealed class AppUpdateLaunchUnknownException:Exception{}
 // Launcher staging is not under test: real package validation remains covered by native tests.
 internal static class VelopackPackage {
  internal const string PackageId="CodexLightDesktop";
  internal sealed class Identity {internal string DataRoot="",CurrentDirectory="",ProgramRoot="";}
  internal sealed class Lease:IDisposable{internal string Path="",Sha256="";public void Dispose(){}}
  internal static Identity ReadInstalled(string directory)=>throw new NotSupportedException();
  internal static Lease Validate(string file,string hash,Identity identity)=>throw new NotSupportedException();
 }
}
