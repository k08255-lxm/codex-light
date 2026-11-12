using System;
using System.IO;
using System.Linq;
using CodexLight.Runtime;

if(args.Length==1&&args[0]=="--version"){
 switch(Environment.GetEnvironmentVariable("CODEX_LIGHT_NODE_TEST")){
  case "old":Console.WriteLine("v18.20.8");return;
  case "invalid":Console.WriteLine("pretend v24.0.0");return;
  case "failed":Console.WriteLine("v24.0.0");Environment.ExitCode=1;return;
  case "huge":Console.Write(new string('a',10000));return;
  case "timeout":System.Threading.Thread.Sleep(15000);return;
  default:Console.WriteLine("v24.0.0");return;
 }
}
void Check(bool condition,string message){if(!condition)throw new Exception(message);Console.WriteLine("PASS "+message);}
string executable=Environment.ProcessPath!;
foreach(string mode in new[]{"valid","old","invalid","failed","huge","timeout"}){
 Environment.SetEnvironmentVariable("CODEX_LIGHT_NODE_TEST",mode);
 var info=NodeRuntimeDetection.Probe(executable,out var failure);
 Check(mode=="valid"?info?.Version=="v24.0.0":info==null,"real process probe: "+mode+" ("+failure+")");
}
Environment.SetEnvironmentVariable("CODEX_LIGHT_NODE_TEST",null);
Check(NodeRuntimeDetection.Probe(Path.Combine(Path.GetTempPath(),Guid.NewGuid()+".exe"),out _) == null,"missing executable rejected");
var candidates=NodeRuntimeDetection.CandidatePaths(AppContext.BaseDirectory).ToArray();
Check(candidates[0]==Path.Combine(AppContext.BaseDirectory,"runtime","node.exe"),"bundled runtime has first priority");
Check(candidates[1]==Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"nodejs","node.exe"),"machine runtime precedes registry and PATH");
Check(candidates.Distinct(StringComparer.OrdinalIgnoreCase).Count()==candidates.Length,"candidate paths deduplicated");
Check(candidates.All(path=>Path.IsPathRooted(path)&&Path.GetFileName(path)=="node.exe"),"only absolute node.exe candidates, no scripts");
var installed=NodeRuntimeDetection.FindCompatible(AppContext.BaseDirectory,out string detail);
Console.WriteLine("LIVE "+detail);
if(installed!=null)Check(File.Exists(installed.Path),"live detection returns existing executable");
string fixture=Path.Combine(Path.GetTempPath(),"CodexLight-node-test-"+Guid.NewGuid().ToString("N"));
string? previousPath=Environment.GetEnvironmentVariable("PATH");
try{
 string runtime=Path.Combine(fixture,"runtime");Directory.CreateDirectory(runtime);
 foreach(string file in new[]{"Test.dll","Test.runtimeconfig.json","Test.deps.json"})File.Copy(Path.Combine(AppContext.BaseDirectory,file),Path.Combine(runtime,file));
 File.Copy(executable,Path.Combine(runtime,"node.exe"));
 Environment.SetEnvironmentVariable("PATH",runtime+";"+runtime.ToUpperInvariant()+";relative-folder;C:drive-relative;C:\\bad:path;"+previousPath);
 var diagnostics=new System.Collections.Generic.List<string>();
 var listed=NodeRuntimeDetection.CandidatePaths(fixture,diagnostics).ToArray();
 Check(listed.Count(path=>path.Equals(Path.Combine(runtime,"node.exe"),StringComparison.OrdinalIgnoreCase))==1,"duplicate PATH and bundled runtime deduplicated");
 Check(diagnostics.Any(message=>message.Contains("PATH")),"invalid PATH entries diagnosed without aborting enumeration");
 var bundled=NodeRuntimeDetection.FindCompatible(fixture,out _);
 Check(bundled?.Path==Path.Combine(runtime,"node.exe"),"actual bundled executable preferred");
 Environment.SetEnvironmentVariable("CODEX_LIGHT_NODE_TEST","old");
 var fallback=NodeRuntimeDetection.FindCompatible(fixture,out string fallbackDetail);
 Check(fallback?.Path!=Path.Combine(runtime,"node.exe")&&fallbackDetail.Contains("v18.20.8"),"old bundled executable rejected and diagnosis retained during fallback");
 if(installed!=null)Check(fallback?.Path==installed.Path,"old bundled executable falls back to real compatible system Node");
}finally{
 Environment.SetEnvironmentVariable("PATH",previousPath);Environment.SetEnvironmentVariable("CODEX_LIGHT_NODE_TEST",null);
 // Only this test's uniquely created fixture directory is removed.
 Directory.Delete(fixture,true);
}
