using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using Microsoft.Win32;
namespace CodexLight.Bootstrap {
 internal sealed class DependencyState {public string Key="",Name="",Detail="";public bool Compatible;}
 internal static class Detection {
  [StructLayout(LayoutKind.Sequential)]struct SystemInfo{public ushort Architecture,Reserved;public uint PageSize;public IntPtr MinimumAddress,MaximumAddress;public UIntPtr ProcessorMask;public uint ProcessorCount,ProcessorType,AllocationGranularity;public ushort ProcessorLevel,ProcessorRevision;}
  [DllImport("kernel32.dll")]static extern void GetNativeSystemInfo(out SystemInfo info);
  static string ReadRuntimeList(string executable){
   using(var process=new Process{StartInfo=new ProcessStartInfo(executable,"--list-runtimes"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true}}){
    try{
     if(!process.Start())throw new InvalidOperationException(".NET 枚举进程未启动。");
     Func<StreamReader,string> read=reader=>{var result=new System.Text.StringBuilder();var buffer=new char[1024];int count;while((count=reader.Read(buffer,0,buffer.Length))>0){if(result.Length+count>65536)throw new InvalidOperationException(".NET 枚举输出超过安全上限。");result.Append(buffer,0,count);}return result.ToString();};
     var stdout=System.Threading.Tasks.Task.Run(()=>read(process.StandardOutput));var stderr=System.Threading.Tasks.Task.Run(()=>read(process.StandardError));
     var timer=Stopwatch.StartNew();
     if(!process.WaitForExit(5000)||!System.Threading.Tasks.Task.WaitAll(new System.Threading.Tasks.Task[]{stdout,stderr},Math.Max(0,5000-(int)timer.ElapsedMilliseconds)))throw new TimeoutException(".NET 运行时枚举超过 5 秒。");
     if(process.ExitCode!=0)throw new InvalidOperationException(".NET 运行时枚举失败，退出码 "+process.ExitCode+"。");
     return stdout.Result;
    }catch(Exception e){try{if(!process.HasExited)process.Kill();}catch{}throw new InvalidOperationException("无法可靠读取已安装的 .NET 运行时；检查已停止，不会将读取失败当作缺失而重装。",e);}
   }
  }
  public static List<DependencyState> Read(string? applicationDirectory=null){
   GetNativeSystemInfo(out var system);
   if(system.Architecture!=9||Environment.OSVersion.Version.Build<19041)throw new InvalidOperationException("需要 Windows x64、版本 19041 或更高；不会升级操作系统。");
   var states=new List<DependencyState>();
   string dotnetRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"dotnet");
   string dotnet=Path.Combine(dotnetRoot,"dotnet.exe");
   var versions=new Dictionary<string,Version>();
   if(File.Exists(dotnet)){
    string output=ReadRuntimeList(dotnet);
    foreach(string line in output.Split(new[]{'\r','\n'},StringSplitOptions.RemoveEmptyEntries)){
     var match=System.Text.RegularExpressions.Regex.Match(line,@"^(\S+) ([0-9]+\.[0-9]+\.[0-9]+) \[(.+)\]$");
     if(!match.Success){if(line.StartsWith("Microsoft.NETCore.App ",StringComparison.Ordinal)||line.StartsWith("Microsoft.WindowsDesktop.App ",StringComparison.Ordinal))throw new InvalidOperationException(".NET 运行时枚举返回无法识别的版本，已停止；不会自动重装。");continue;}
     string framework=match.Groups[1].Value;
     if(framework!="Microsoft.NETCore.App"&&framework!="Microsoft.WindowsDesktop.App")continue;
     if(!Version.TryParse(match.Groups[2].Value,out var version)||version.Major!=10)continue;
     string expected=Path.Combine(dotnetRoot,"shared",framework);
     if(!string.Equals(Path.GetFullPath(match.Groups[3].Value).TrimEnd('\\'),expected,StringComparison.OrdinalIgnoreCase)||!Directory.Exists(Path.Combine(expected,match.Groups[2].Value)))throw new InvalidOperationException(".NET 枚举路径与实际标准安装目录不一致，已停止；不会自动重装。");
     if(!versions.TryGetValue(framework,out var previous)||version>previous)versions[framework]=version;
    }
   }
   states.Add(new DependencyState{Key="dotnet",Name=".NET 10 桌面运行时",Compatible=versions.Count==2,Detail=string.Join("；",new[]{"Microsoft.NETCore.App","Microsoft.WindowsDesktop.App"}.Select(name=>name+": "+(versions.TryGetValue(name,out var version)?version.ToString():"未发现兼容版本")))});
   Version? web=null;
   foreach(var hive in new[]{RegistryHive.LocalMachine,RegistryHive.CurrentUser})foreach(var view in new[]{RegistryView.Registry32,RegistryView.Registry64}){
    using(var root=RegistryKey.OpenBaseKey(hive,view))using(var clients=root.OpenSubKey(@"SOFTWARE\Microsoft\EdgeUpdate\Clients")){
     if(clients==null)continue;foreach(var id in clients.GetSubKeyNames())using(var client=clients.OpenSubKey(id)){
      if((string?)client?.GetValue("name")!="Microsoft Edge WebView2 Runtime")continue;
      if(Version.TryParse(client?.GetValue("pv") as string,out var v)&&(web==null||v>web))web=v;
     }
    }
   }
   states.Add(new DependencyState{Key="webview",Name="Microsoft WebView2",Compatible=web!=null&&web.Major>=142,Detail=web?.ToString()??"未发现兼容运行时"});
   var node=CodexLight.Runtime.NodeRuntimeDetection.FindCompatible(applicationDirectory??Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"payload"),out string nodeDetail);
   states.Add(new DependencyState{Key="node",Name="Node.js 20+",Compatible=node!=null,Detail=nodeDetail});return states;
  }
 }
 [DataContract]internal sealed class LockedDependency {[DataMember(Name="url")]public string Url="";[DataMember(Name="hash")]public string Hash="";[DataMember(Name="algorithm")]public string Algorithm="";}
 [DataContract]internal sealed class DependencyLock {[DataMember(Name="dotnet")]public LockedDependency Dotnet=new LockedDependency();[DataMember(Name="node")]public LockedDependency Node=new LockedDependency();[DataMember(Name="webview")]public LockedDependency Webview=new LockedDependency();}
}
