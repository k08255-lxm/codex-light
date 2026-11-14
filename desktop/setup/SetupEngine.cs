using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodexLight.Setup.Tests")]
namespace CodexLight.Bootstrap {
 internal enum SetupPhase { Checking, Preparing, Downloading, Verifying, RuntimeInstalling, ApplicationInstalling }
 internal sealed class SetupProgress {
  public SetupPhase Phase { get; }
  public string Message { get; }
  public long? Bytes { get; }
  public long? TotalBytes { get; }
  public double? Percent=>Bytes.HasValue&&TotalBytes.HasValue&&TotalBytes.Value>0&&Bytes.Value<=TotalBytes.Value?(double?)((double)Bytes.Value/TotalBytes.Value*100):null;
  public SetupProgress(SetupPhase phase,string message,long? bytes=null,long? totalBytes=null){Phase=phase;Message=message;Bytes=bytes>=0?bytes:null;TotalBytes=totalBytes>0?totalBytes:null;}
  public static SetupPhase DependencyPhase(string message)=>message.Contains("下载")?SetupPhase.Downloading:message.Contains("核验")?SetupPhase.Verifying:message.Contains("安装")||message.Contains("等待官方")?SetupPhase.RuntimeInstalling:SetupPhase.Preparing;
 }
 internal static class ExitCodePolicy {
  public static bool IsSuccess(int code)=>code==0||code==3010||code==1641;
  public static void RequireSuccess(int code,string component){if(IsSuccess(code))return;if(code==1602)throw new OperationCanceledException(component+"安装已取消（1602）。");throw new InvalidOperationException(component+"安装失败（"+code+"）。"+(code==1618?"另一个安装程序正在运行，请稍后重试。":code==1638?"已存在冲突的版本，请使用对应版本的安装器。":"请展开详情查看安装日志。"));}
 }
 internal static class InstallPaths {
  public const string UpgradeCode="{C63D113F-36E4-46F6-B635-F1CE57BD166E}";
  public static string Default=>Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","CodexLight");
  public static string UnderParent(string parent)=>Path.Combine(parent,"CodexLight");
  public static string Validate(string value,bool registered){
   if(string.IsNullOrWhiteSpace(value)||!System.Text.RegularExpressions.Regex.IsMatch(value,@"^[A-Za-z]:[\\/]")||value.StartsWith(@"\\",StringComparison.Ordinal)||value.Contains('"'))throw new InvalidOperationException("请选择本机磁盘中的安装位置。");
   string full=Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
   if(full.Length>200)throw new InvalidOperationException("安装路径过长，请选择不超过 200 个字符的位置。");
   if(full.Length<4||full==Path.GetPathRoot(full)?.TrimEnd('\\'))throw new InvalidOperationException("请选择磁盘内的子目录。");
   if(File.Exists(full)||(!registered&&Directory.Exists(full)))throw new InvalidOperationException("此位置已存在。请更改安装位置；已有安装和文件不会被覆盖。");
   return full;
  }
  public static string? Registered(){
   var product=new StringBuilder(39);int result=MsiEnumRelatedProducts(UpgradeCode,0,0,product);
   if(result==259)return null;if(result!=0)throw new InvalidOperationException("无法读取 Windows Installer 安装登记（"+result+"）。");
   uint length=32767;var path=new StringBuilder((int)length);result=MsiGetProductInfo(product.ToString(),"InstallLocation",path,ref length);
   if(result!=0||path.Length==0)throw new InvalidOperationException("现有 MSI 安装路径不可读，请通过 Windows 设置修复或卸载后重试。");
   return Path.GetFullPath(path.ToString()).TrimEnd('\\');
  }
  public static void ValidateUpgrade(string version,string productCode){
   var installed=new StringBuilder(39);int result=MsiEnumRelatedProducts(UpgradeCode,0,0,installed);
   if(result==259)return;if(result!=0)throw new InvalidOperationException("无法读取 Windows Installer 安装登记（"+result+"）。");
   uint length=256;var previousVersion=new StringBuilder((int)length);result=MsiGetProductInfo(installed.ToString(),"VersionString",previousVersion,ref length);
   if(result!=0)throw new InvalidOperationException("无法读取已安装版本（"+result+"），尚未开始安装。");
   ValidateUpgradeIdentity(previousVersion.ToString(),installed.ToString(),version,productCode);
  }
  internal static void ValidateUpgradeIdentity(string previousVersion,string previousCode,string version,string productCode){
   if(!Version.TryParse(previousVersion,out var previous)||!Version.TryParse(version,out var next))throw new InvalidOperationException("安装版本信息无效，尚未开始安装。");
   int order=next.CompareTo(previous);
   if(order<0)throw new InvalidOperationException("已安装 "+previousVersion+"，不能安装较旧的 "+version+"。请下载最新安装包。");
   if(order==0&&!string.Equals(previousCode,productCode,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("已安装另一个 "+version+" 候选包，产品标识与此安装包不同。请使用更高版本的安装包升级；现有文件未更改。");
  }
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern int MsiEnumRelatedProducts(string upgradeCode,int reserved,int index,StringBuilder productCode);
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern int MsiGetProductInfo(string product,string property,StringBuilder value,ref uint length);
 }
 internal sealed class SetupEngine {
  public static string PackageFileName(string version){
   if(!System.Text.RegularExpressions.Regex.IsMatch(version??"",@"^\d{1,3}\.\d{1,3}\.\d{1,5}$")||!Version.TryParse(version,out var parsed)||parsed.Major>255||parsed.Minor>255||parsed.Build>65535)throw new InvalidOperationException("嵌入 MSI 的产品版本无效。");
   return "CodexLight-"+version+"-x64.msi";
  }
  public static string MsiArguments(string msi,string target,string log,bool reinstall=false,bool verbose=false)=>"/i \""+msi+"\" /qn /norestart "+SetupLogs.Switch(verbose)+" \""+log+"\" SETUP_PREREQUISITES_VERIFIED=1 MSIRESTARTMANAGERCONTROL=DisableShutdown INSTALLFOLDER=\""+target+"\""+(reinstall?" REINSTALL=ALL REINSTALLMODE=vomus":"");
  // The authored MSI filename must survive extraction: secure repair resolves this name in SourceDir.
  // Read identity from the embedded package, not the bootstrapper assembly/build input filename.
  internal static async Task CopyPackage(Stream input,Stream output,CancellationToken token,Action<long,long?>? progress=null){
   long? total=input.CanSeek?(long?)(input.Length-input.Position):null;long copied=0;var reportClock=Stopwatch.StartNew();progress?.Invoke(copied,total);
   byte[] buffer=new byte[65536];int count;
   while((count=await input.ReadAsync(buffer,0,buffer.Length,token))>0){await output.WriteAsync(buffer,0,count,token);copied+=count;if(reportClock.ElapsedMilliseconds>=100){progress?.Invoke(copied,total);reportClock.Restart();}}
   progress?.Invoke(copied,total);
   token.ThrowIfCancellationRequested();
  }
  internal static async Task<EmbeddedPackage> ExtractPackage(Stream input,string cache,CancellationToken token,Action<long,long?>? progress=null,Action? verifying=null){
   string temporary=Path.Combine(cache,"embedded.msi");
   using(var output=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None,65536,FileOptions.Asynchronous|FileOptions.SequentialScan))await CopyPackage(input,output,token,progress);
   verifying?.Invoke();
   var package=EmbeddedPackage.Read(temporary);string final=Path.Combine(cache,PackageFileName(package.Version));File.Move(temporary,final);package.Path=final;return package;
  }
  // Detection, package metadata and process startup must never resume on the WPF dispatcher.
  public Task<int> Run(string target,bool registered,Action<string> progress,Action<bool> canCancel,CancellationToken token,IProgress<SetupProgress>? phaseProgress=null)=>Task.Run(()=>RunCore(target,registered,progress,canCancel,token,phaseProgress),token);
  async Task<int> RunCore(string target,bool registered,Action<string> progress,Action<bool> canCancel,CancellationToken token,IProgress<SetupProgress>? phaseProgress){
   Action<SetupPhase,string> report=(phase,message)=>{progress(message);phaseProgress?.Report(new SetupProgress(phase,message));};
   report(SetupPhase.Checking,"正在检查安装位置和运行环境…");
   target=InstallPaths.Validate(target,registered);
   var states=Detection.Read(target);int restart=0;
   foreach(var dependency in states.Where(x=>!x.Compatible)){
    report(SetupPhase.Preparing,"准备 "+dependency.Name+"…");
    int code=await DependencyInstaller.Install(dependency.Key,message=>report(SetupProgress.DependencyPhase(message),dependency.Name+" · "+message),token,canCancel,true,(bytes,total)=>phaseProgress?.Report(new SetupProgress(SetupPhase.Downloading,dependency.Name+" · 正在下载…",bytes,total)));
    if(code==3010||code==1641)restart=code;
    report(SetupPhase.Checking,"正在复查 "+dependency.Name+"…");
    var current=Detection.Read(target);
    if(!current.Single(x=>x.Key==dependency.Key).Compatible)throw new InvalidOperationException(dependency.Name+"安装后检查未通过。"+(restart!=0?"请重启 Windows 后重试。":"请查看详情，确认官方安装成功后重试。"));
   }
   token.ThrowIfCancellationRequested();report(SetupPhase.Checking,"正在复查全部运行环境…");
   if(!Detection.Read(target).All(x=>x.Compatible))throw new InvalidOperationException("运行环境复查未通过，尚未开始安装应用。");
   canCancel(true);token.ThrowIfCancellationRequested();
   string cache=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLight","SetupLogs",DateTime.Now.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N").Substring(0,8));
   Directory.CreateDirectory(cache);string log=Path.Combine(cache,"install.log");EmbeddedPackage package;
   report(SetupPhase.Preparing,"正在解压 Codex Light 安装包…");
   // Extract only the embedded MSI. Windows Installer owns every installed application file.
   using(var input=Assembly.GetExecutingAssembly().GetManifestResourceStream("CodexLight.Application.msi")){
    if(input==null)throw new InvalidOperationException("安装包缺少嵌入的 MSI。");
    package=await ExtractPackage(input,cache,token,(bytes,total)=>phaseProgress?.Report(new SetupProgress(SetupPhase.Preparing,"正在解压 Codex Light 安装包…",bytes,total)),()=>report(SetupPhase.Verifying,"正在读取并核验 Codex Light 安装包信息…"));
   }
   InstallPaths.ValidateUpgrade(package.Version,package.ProductCode);
   RunningApplication.EnsureStopped(target);
   token.ThrowIfCancellationRequested();canCancel(false);report(SetupPhase.ApplicationInstalling,"Windows Installer 正在安装 Codex Light…"+Environment.NewLine+"Windows Installer 日志："+log);
   bool verbose=SetupLogs.Verbose;int? exitCode=null;var installClock=Stopwatch.StartNew();
   try{
    using(var process=Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"msiexec.exe"),MsiArguments(package.Path,target,log,package.InstalledForCurrentUser(),verbose)){UseShellExecute=false,CreateNoWindow=true})){
     if(process==null)throw new InvalidOperationException("Windows Installer 未启动。");await Task.Run(()=>process.WaitForExit());exitCode=process.ExitCode;ExitCodePolicy.RequireSuccess(process.ExitCode,"Codex Light");return process.ExitCode==0?restart:process.ExitCode;
    }
   }catch(Win32Exception e)when(e.NativeErrorCode==1223){throw new OperationCanceledException("系统授权已取消。",e);}
   finally{installClock.Stop();if(exitCode.HasValue){try{SetupLogs.Complete(cache,exitCode.Value,installClock.ElapsedMilliseconds,verbose,DateTime.UtcNow);SetupCacheCleanup.Run(exitCode.Value==0?restart:exitCode.Value,package,target,progress);}catch(Exception e){progress("日志整理未完成，安装结果不变："+e.Message);}}progress("安装日志保留在："+cache);}
  }
 }
 internal sealed class EmbeddedPackage {
  public string Path="",Version="",ProductCode="";
  public static EmbeddedPackage Read(string file){
   uint database=0;
   try{
    Check(MsiOpenDatabase(file,IntPtr.Zero,out database));
    var package=new EmbeddedPackage{Path=file,Version=Property(database,"ProductVersion"),ProductCode=Property(database,"ProductCode")};
    SetupEngine.PackageFileName(package.Version);
    if(!Guid.TryParse(package.ProductCode,out _)||!string.Equals(Property(database,"UpgradeCode"),InstallPaths.UpgradeCode,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("嵌入 MSI 不属于 Codex Light 产品系列。");
    return package;
   }finally{if(database!=0)MsiCloseHandle(database);}
  }
  static string Property(uint database,string name){
   uint view=0,record=0;
   try{
    Check(MsiDatabaseOpenView(database,"SELECT `Value` FROM `Property` WHERE `Property`='"+name+"'",out view));Check(MsiViewExecute(view,0));Check(MsiViewFetch(view,out record));
    var text=new StringBuilder(1024);uint length=1024;Check(MsiRecordGetString(record,1,text,ref length));if(text.Length==0)throw new InvalidOperationException("嵌入 MSI 缺少必要产品信息。");return text.ToString();
   }finally{if(record!=0)MsiCloseHandle(record);if(view!=0)MsiCloseHandle(view);}
  }
  static void Check(uint code){if(code!=0)throw new InvalidOperationException("无法读取嵌入 MSI 产品信息（"+code+"）。");}
  public bool InstalledForCurrentUser(){int state=MsiQueryProductState(ProductCode);if(state==-2)throw new InvalidOperationException("MSI 产品标识无效。");return state==5;}
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiOpenDatabase(string file,IntPtr persist,out uint database);
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiDatabaseOpenView(uint database,string query,out uint view);
  [DllImport("msi.dll")]static extern uint MsiViewExecute(uint view,uint record);
  [DllImport("msi.dll")]static extern uint MsiViewFetch(uint view,out uint record);
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiRecordGetString(uint record,uint field,StringBuilder value,ref uint length);
  [DllImport("msi.dll")]static extern uint MsiCloseHandle(uint handle);
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern int MsiQueryProductState(string productCode);
 }
}
