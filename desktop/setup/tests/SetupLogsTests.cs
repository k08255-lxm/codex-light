using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using CodexLight.Bootstrap;
internal static class SetupLogsTests {
 internal static void Run() {
  string root=Path.Combine(Path.GetTempPath(),"codex-light-log-policy-tests-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  Action<bool,string> check=(ok,message)=>{if(!ok)throw new Exception(message);};
  Func<string,string> make=name=>{string dir=Path.Combine(root,name);Directory.CreateDirectory(dir);return dir;};
  string current=make("20261114-120000-aabbccdd");string text=string.Concat(Enumerable.Repeat("Action start: InstallFiles\n",5000));
  File.WriteAllText(Path.Combine(current,"install.log"),text);File.WriteAllText(Path.Combine(current,"keep.msi"),"MSI");
  SetupLogs.Complete(current,0,1000,false,DateTime.UtcNow);
  check(!File.Exists(Path.Combine(current,"install.log")),"successful raw log archived");
  using(var f=File.OpenRead(Path.Combine(current,"install.log.gz")))using(var g=new GZipStream(f,CompressionMode.Decompress))using(var r=new StreamReader(g))check(r.ReadToEnd()==text,"archive roundtrip exact");
  check(File.ReadAllText(Path.Combine(current,"keep.msi"))=="MSI","MSI never removed");
  check(File.ReadAllText(Path.Combine(current,"result.txt")).Contains("msiElapsedMs=1000"),"elapsed and exit diagnostics retained");
  string failed=make("20261114-120001-aabbccdd");File.WriteAllText(Path.Combine(failed,"install.log"),"failure");SetupLogs.Complete(failed,1603,2,false,DateTime.UtcNow);
  check(File.Exists(Path.Combine(failed,"install.log"))&&!File.Exists(Path.Combine(failed,"log-policy.txt")),"failed log untouched");
  string old=make("20260101-120001-aabbccdd");File.WriteAllText(Path.Combine(old,"install.log.gz"),"old unowned archive");File.SetLastWriteTimeUtc(Path.Combine(old,"install.log.gz"),DateTime.UtcNow.AddDays(-100));
  for(int i=0;i<12;i++){string dir=make("20261114-13"+i.ToString("00")+"00-aabbccdd");File.WriteAllText(Path.Combine(dir,"install.log"),"success");File.WriteAllText(Path.Combine(dir,"keep.msi"),"MSI");SetupLogs.Complete(dir,3010,1,true,DateTime.UtcNow);}
  check(Directory.GetFiles(root,"log-policy.txt",SearchOption.AllDirectories).Length==13,"retention leaves ownership summaries");
  check(Directory.GetFiles(root,"install.log.gz",SearchOption.AllDirectories).Length==11,"10 managed archives plus legacy archive retained");
  check(File.Exists(Path.Combine(old,"install.log.gz")),"unowned legacy archive never pruned");
  check(Directory.GetFiles(root,"keep.msi",SearchOption.AllDirectories).Length==13,"all source packages retained");
  foreach(string log in Directory.GetFiles(root,"install.log.gz",SearchOption.AllDirectories).Where(p=>!p.StartsWith(old+Path.DirectorySeparatorChar)))File.SetLastWriteTimeUtc(log,DateTime.UtcNow.AddDays(-31));
  SetupLogs.Prune(root,failed,DateTime.UtcNow);
  check(Directory.GetFiles(root,"install.log.gz",SearchOption.AllDirectories).Length==1,"managed old archives expire after 30 days");
  check(SetupEngine.MsiArguments("a","b","c").Contains("/Lweamo")&&!SetupEngine.MsiArguments("a","b","c").Contains("/L*v"),"normal logging not verbose");
  check(SetupEngine.MsiArguments("a","b","c",false,true).Contains("/L*v"),"explicit diagnostic logging supported");
  Console.WriteLine("PASS: log archive integrity, failure preservation, age/count retention, legacy/MSI preservation, logging modes. Fixtures: "+root);
 }
}