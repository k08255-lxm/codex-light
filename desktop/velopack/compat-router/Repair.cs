using System;
using System.IO;
using System.Linq;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Collections.Generic;
namespace CodexLight.PublicSetup {
 // Opt-in build only until isolated native lifecycle validation passes.
 internal static class Repair {
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=16384};
  internal static bool Ready(string json,int pid,string time,string hash){
   if(json.Length>16384)return false;
   foreach(var key in new[]{"ready","parentPid","parentStartUtc","packageId","hash"})if(System.Text.RegularExpressions.Regex.Matches(json,"\""+key+"\"\\s*:").Count!=1)return false;
   var d=Json.Deserialize<Dictionary<string,object>>(json);
   return d!=null&&d.Count==5&&d.ContainsKey("ready")&&d["ready"] is bool&& (bool)d["ready"]&&d.ContainsKey("parentPid")&&d["parentPid"] is int&&(int)d["parentPid"]==pid&&d.ContainsKey("parentStartUtc")&&(string)d["parentStartUtc"]==time&&d.ContainsKey("packageId")&&(string)d["packageId"]=="CodexLightDesktop"&&d.ContainsKey("hash")&&(string)d["hash"]==hash;
  }
  static void WriteNew(string path,string text){VerifiedLease.Plain(Path.GetDirectoryName(path)!);using(var s=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None))using(var w=new StreamWriter(s)){w.Write(text);w.Flush();s.Flush(true);}}
#if REPAIR
  static void Resource(string name,string path){VerifiedLease.Plain(path);using(var input=typeof(Repair).Assembly.GetManifestResourceStream(name)??throw new IOException("Missing recovery resource"))using(var output=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None)){if(input.Length>300L*1024*1024)throw new IOException("Recovery resource too large");input.CopyTo(output);output.Flush(true);}}
  internal static async Task Prepare(Func<bool> confirm,Action exit){
   string local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),updates=Path.Combine(local,"CodexLight","Updates");
   string packageDir=Path.Combine(updates,Pins.Version+"-"+RepairPins.PackageHash.Substring(0,16));
   VerifiedLease.Plain(packageDir);Directory.CreateDirectory(packageDir);
   string package=Path.Combine(packageDir,"CodexLightDesktop-"+Pins.Version+"-full.nupkg");
   if(!File.Exists(package))Resource("CodeCang.Repair.nupkg",package);
   using(var held=VerifiedLease.Open(package,RepairPins.PackageHash)){
    string cache=Path.Combine(local,"CodexLightMigration","repair-"+Guid.NewGuid().ToString("N"));VerifiedLease.Plain(cache);Directory.CreateDirectory(cache);
    string zip=Path.Combine(cache,"helper.zip");Resource("CodeCang.Repair.zip",zip);
    using(var verified=VerifiedLease.Open(zip,RepairPins.HelperHash))using(var helper=FreshLease.Extract(verified,Path.Combine(cache,"helper"),"CodeCang.BootstrapWorker.exe")){
     string apply=Path.Combine(updates,"Apply");VerifiedLease.Plain(apply);Directory.CreateDirectory(apply);
     string receipt=Path.Combine(apply,Guid.NewGuid().ToString("N")+".json");
     using(var parent=Process.GetCurrentProcess()){
      int pid=parent.Id;string time=parent.StartTime.ToUniversalTime().ToString("O");
      WriteNew(receipt,Json.Serialize(new{root=Path.Combine(local,"CodexLightDesktop"),package,hash=RepairPins.PackageHash,parentPid=pid,parentStartUtc=time,packageId="CodexLightDesktop"}));
      bool committed=false;
      try{
       using(var child=Process.Start(new ProcessStartInfo(helper.Installer,"--receipt \""+receipt+"\""){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=Path.GetDirectoryName(helper.Installer)})??throw new IOException("Recovery helper did not start")){
        var timer=Stopwatch.StartNew();while(!File.Exists(receipt+".ready.json")){if(child.HasExited)throw new IOException("Recovery helper stopped; diagnostic receipt: "+receipt);if(timer.Elapsed>TimeSpan.FromSeconds(30))throw new TimeoutException("Recovery helper readiness timed out");await Task.Delay(100);}
        VerifiedLease.Plain(receipt+".ready.json");var info=new FileInfo(receipt+".ready.json");if(info.Length>16384||!Ready(File.ReadAllText(info.FullName),pid,time,RepairPins.PackageHash)||child.HasExited)throw new IOException("Recovery readiness identity mismatch");
        if(!confirm())throw new OperationCanceledException("Recovery canceled; installation unchanged");
        // Consent above covers graceful closure only; never force-terminate an app.
        await CodexLight.Bootstrap.RunningApplication.PrepareAsync(Path.Combine(local,"CodexLightDesktop","current"),(_,token)=>Task.FromResult(true),System.Threading.CancellationToken.None);
        if(child.HasExited)throw new IOException("Recovery helper stopped before confirmation");
        WriteNew(receipt+".commit","");committed=true;exit();
       }
      }finally{if(!committed)WriteNew(receipt+".cancel","");}
     }
    }
   }
  }
#endif
 }
}
