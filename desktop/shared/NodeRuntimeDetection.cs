using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace CodexLight.Runtime {
 internal sealed class NodeRuntimeInfo {
  public string Path { get; }
  public string Version { get; }
  public NodeRuntimeInfo(string path,string version){Path=path;Version=version;}
 }
 internal static class NodeRuntimeDetection {
  public static NodeRuntimeInfo? FindCompatible(string applicationDirectory)=>FindCompatible(applicationDirectory,out _);
  public static NodeRuntimeInfo? FindCompatible(string applicationDirectory,out string detail){
   var failures=new List<string>();
   foreach(string candidate in CandidatePaths(applicationDirectory,failures)){
    if(!File.Exists(candidate))continue;
    var runtime=Probe(candidate,out string failure);
    if(runtime!=null){detail=runtime.Version+" — "+runtime.Path+(failures.Count==0?"":Environment.NewLine+string.Join(Environment.NewLine,failures));return runtime;}
    failures.Add(candidate+"："+failure);
   }
   detail=failures.Count==0?"未发现可启动的 Node.js 20+；可安装锁定的官方 Node.js 运行时。":string.Join(Environment.NewLine,failures)+Environment.NewLine+"未发现兼容版本；可安装锁定的官方 Node.js 运行时。";
   return null;
  }
  internal static IEnumerable<string> CandidatePaths(string applicationDirectory,List<string>? diagnostics=null){
   var candidates=new List<string>{System.IO.Path.Combine(applicationDirectory,"runtime","node.exe"),System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"nodejs","node.exe")};
   foreach(var hive in new[]{RegistryHive.LocalMachine,RegistryHive.CurrentUser})foreach(var view in new[]{RegistryView.Registry64,RegistryView.Registry32}){
    try{using(var root=RegistryKey.OpenBaseKey(hive,view))using(var key=root.OpenSubKey(@"SOFTWARE\Node.js")){
     string? location=key?.GetValue("InstallPath") as string;
     if(!string.IsNullOrWhiteSpace(location))AddDirectory(candidates,location!,diagnostics,"注册表 "+hive+"/"+view);
    }}catch(Exception error)when(error is System.Security.SecurityException||error is UnauthorizedAccessException||error is IOException){diagnostics?.Add("无法读取 Node.js 注册表 "+hive+"/"+view+"："+error.GetType().Name);}
   }
   // A newly installed MSI updates the registry, not the already running process's PATH.
   foreach(string entry in (Environment.GetEnvironmentVariable("PATH")??"").Split(';')){
    string directory=entry.Trim().Trim('"');
    if(directory.Length>0)AddDirectory(candidates,directory,diagnostics,"PATH");
   }
   var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   foreach(string candidate in candidates){
    string full;
    try{full=System.IO.Path.GetFullPath(candidate);}catch(Exception error)when(error is ArgumentException||error is NotSupportedException||error is PathTooLongException){diagnostics?.Add("忽略无效 Node.js 路径："+error.GetType().Name);continue;}
    if(seen.Add(full))yield return full;
   }
  }
  static void AddDirectory(List<string> candidates,string directory,List<string>? diagnostics,string source){
   try{
    string? root=System.IO.Path.GetPathRoot(directory);
    if(string.IsNullOrEmpty(root)||root=="\\"||root.EndsWith(":",StringComparison.Ordinal)){diagnostics?.Add("忽略 "+source+" 中的相对目录");return;}
    candidates.Add(System.IO.Path.GetFullPath(System.IO.Path.Combine(directory,"node.exe")));
   }catch(Exception error)when(error is ArgumentException||error is NotSupportedException||error is PathTooLongException){diagnostics?.Add("忽略 "+source+" 中的无效目录："+error.GetType().Name);}
  }
  internal static NodeRuntimeInfo? Probe(string executable,out string failure){
   failure="无法启动";
   using(var process=new Process{StartInfo=new ProcessStartInfo(executable,"--version"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true}}){
    try{
     if(!process.Start())return null;
     Func<StreamReader,string> read=reader=>{var text=new System.Text.StringBuilder();var buffer=new char[256];int count;while((count=reader.Read(buffer,0,buffer.Length))>0){if(text.Length+count>4096)throw new InvalidOperationException("版本输出超过上限");text.Append(buffer,0,count);}return text.ToString();};
     var stdout=Task.Run(()=>read(process.StandardOutput));var stderr=Task.Run(()=>read(process.StandardError));var timer=Stopwatch.StartNew();
     if(!process.WaitForExit(5000)||!Task.WaitAll(new Task[]{stdout,stderr},Math.Max(0,5000-(int)timer.ElapsedMilliseconds))){failure="版本检查超过 5 秒";return null;}
     string output=stdout.Result.Trim();
     if(process.ExitCode!=0){failure="版本检查退出码 "+process.ExitCode;return null;}
     var match=Regex.Match(output,@"^v([0-9]+\.[0-9]+\.[0-9]+)$");
     if(!match.Success||!System.Version.TryParse(match.Groups[1].Value,out var version)){failure="无法识别的 Node.js 版本输出";return null;}
     if(version.Major<20){failure=output+"，需要 Node.js 20+";return null;}
     failure="";return new NodeRuntimeInfo(executable,output);
    }catch(Exception error)when(error is System.ComponentModel.Win32Exception||error is InvalidOperationException||error is AggregateException||error is IOException){failure="版本检查失败："+error.GetType().Name;return null;}
    finally{try{if(!process.HasExited)process.Kill();}catch(InvalidOperationException){}catch(System.ComponentModel.Win32Exception){}}
   }
  }
 }
}
