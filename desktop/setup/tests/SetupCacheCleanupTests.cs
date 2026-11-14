using System;
using System.IO;
using System.Linq;
using CodexLight.Bootstrap;
internal static class SetupCacheCleanupTests {
 internal static void Run() {
  string root=Path.Combine(Path.GetTempPath(),"codex-light-cleanup-tests-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  int checks=0;Action<bool,string> check=(ok,message)=>{checks++;if(!ok)throw new Exception(message);};
  Func<string,string[],string> make=(name,files)=>{string d=Path.Combine(root,name);Directory.CreateDirectory(d);foreach(var f in files)File.WriteAllText(Path.Combine(d,f),"fixture");return d;};
  var current=make("20261114-120000-aabbccdd",new[]{"CodexLight-0.4.3-x64.msi","install.log"});
  var owned=make("20261113-120000-aabbccdd",new[]{"CodexLight-0.4.2-x64.msi","install.log","result.txt","log-policy.txt"});
  var extra=make("20261113-120001-aabbccdd",new[]{"CodexLight-0.4.2-x64.msi","user-notes.txt"});
  var unowned=make("20261113-120002-aabbccdd",new[]{"CodexLight-0.4.2-x64.msi","install.log"});
  var nested=make("20261113-120003-aabbccdd",new[]{"CodexLight-0.4.2-x64.msi"});Directory.CreateDirectory(Path.Combine(nested,"user"));
  var arbitrary=make("private",new[]{"CodexLight-0.4.2-x64.msi"});
  var logonly=make("20261113-120004-aabbccdd",new[]{"install.log"});
  var duplicate=make("20261113-120005-aabbccdd",new[]{"CodexLight-0.4.1-x64.msi","CodexLight-0.4.2-x64.msi"});
  var update=make("0.4.2-abcdef0123456789",new[]{"CodexLight-Setup.exe"});
  var future=make("0.4.4-abcdef0123456789",new[]{"CodexLight-Setup.exe"});
  var equal=make("0.4.3-abcdef0123456789",new[]{"CodexLight-Setup.exe"});
  var partial=make("0.4.1-abcdef0123456789",new[]{"CodexLight-Setup.exe","partial"});
  Func<string,bool> msi=f=>Path.GetDirectoryName(f)==owned;
  Func<string,bool> exe=f=>Path.GetDirectoryName(f)==update;
  int fileCount=Directory.GetFiles(root,"*",SearchOption.AllDirectories).Length;
  var result=SetupCacheCleanup.Candidates(root,current,new Version("0.4.3"),msi,exe);
  check(result.Length==2&&result.Contains(owned)&&result.Contains(update),"only proven old caches eligible");
  foreach(var d in new[]{current,extra,unowned,nested,arbitrary,logonly,duplicate,future,equal,partial})check(!result.Contains(d),"unsafe candidate excluded "+d);
  check(!SetupCacheCleanup.Candidates(root,current,new Version("0.4.3"),f=>throw new IOException("unknown MSI state"),f=>false).Any(),"inspection errors fail closed");
  check(!SetupCacheCleanup.Candidates(root+"missing",current,new Version("0.4.3"),msi,exe).Any(),"missing cache harmless");
  // These branches must not call Windows Installer APIs, touch a source or recycle anything.
  foreach(int code in new[]{3010,1641,1603,1602,1618}){SetupCacheCleanup.Run(code,new EmbeddedPackage(),"not a target",s=>throw new Exception("unexpected cleanup"));check(true,"nonzero exit skips cleanup");}
  check(Directory.GetFiles(root,"*",SearchOption.AllDirectories).Length==fileCount,"planning never changes fixture files");
  var pkg=new EmbeddedPackage{Path=Path.Combine(current,"CodexLight-0.4.3-x64.msi"),Version="0.4.3"};
  check(SetupCacheCleanup.CurrentMatches(pkg,root,true,"0.4.3",root,current),"exact current source accepted");
  check(!SetupCacheCleanup.CurrentMatches(pkg,root,false,"0.4.3",root,current),"uninstalled current rejected");
  check(!SetupCacheCleanup.CurrentMatches(pkg,root,true,"0.4.2",root,current),"wrong installed version rejected");
  check(!SetupCacheCleanup.CurrentMatches(pkg,root,true,"0.4.3",root+"other",current),"wrong installed target rejected");
  check(!SetupCacheCleanup.CurrentMatches(pkg,root,true,"0.4.3",root,owned),"old source reference prevents cleanup");
  check(!SetupCacheCleanup.CurrentMatches(pkg,root,true,"0.4.3",root,""),"missing source prevents cleanup");
  var archiveRoot=Path.Combine(root,"archives");
  var archiveSource=make("archive-source",new[]{"install.log","CodexLight-0.4.2-x64.msi"});
  File.WriteAllText(Path.Combine(archiveSource,"install.log"),string.Concat(Enumerable.Repeat("Diagnostic line\n",10000)));
  var originals=Directory.GetFiles(archiveSource).ToDictionary(Path.GetFileName,File.ReadAllBytes);
  var archive=RecoverableArchive.Archive(archiveSource,archiveRoot);
  check(!Directory.Exists(archiveSource)&&File.Exists(Path.Combine(archive,"verified.txt")),"verified archive replaces only test source");
  foreach(var entry in originals){using(var f=File.OpenRead(Path.Combine(archive,entry.Key+".gz")))using(var g=new System.IO.Compression.GZipStream(f,System.IO.Compression.CompressionMode.Decompress))using(var m=new MemoryStream()){g.CopyTo(m);check(m.ToArray().SequenceEqual(entry.Value),"exact archive roundtrip "+entry.Key);}}
  check(File.Exists(Path.Combine(archive,"Restore.ps1")),"recovery script retained");
  var corrupt=make("corrupt-source",new[]{"install.log"});bool rejected=false;
  try{RecoverableArchive.Archive(corrupt,archiveRoot,a=>File.WriteAllText(Path.Combine(a,"install.log.gz"),"corrupt"));}catch{rejected=true;}
  check(rejected&&File.ReadAllText(Path.Combine(corrupt,"install.log"))=="fixture","bad archive retains original");
  Console.WriteLine("ARCHIVE_RESTORE_FIXTURE: "+archive);
  Console.WriteLine("PASS: "+checks+" cache ownership/current/unknown/partial/version/failure/reboot checks. Fixtures: "+root);
 }
}
