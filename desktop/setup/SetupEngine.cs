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
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern int MsiEnumRelatedProducts(string upgradeCode,int reserved,int index,StringBuilder productCode);
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern int MsiGetProductInfo(string product,string property,StringBuilder value,ref uint length);
 }
 internal sealed class SetupEngine {
  public static string MsiArguments(string msi,string target,string log)=>"/i \""+msi+"\" /qn /norestart /L*v \""+log+"\" SETUP_PREREQUISITES_VERIFIED=1 INSTALLFOLDER=\""+target+"\"";
  public async Task<int> Run(string target,bool registered,Action<string> progress,Action<bool> canCancel,CancellationToken token){
   target=InstallPaths.Validate(target,registered);
   var states=await Task.Run(()=>Detection.Read(target));int restart=0;
   foreach(var dependency in states.Where(x=>!x.Compatible)){
    progress("准备 "+dependency.Name+"…");
    int code=await DependencyInstaller.Install(dependency.Key,message=>progress(dependency.Name+" · "+message),token,canCancel,true);
    if(code==3010||code==1641)restart=code;
    progress("复查 "+dependency.Name+"…");
    var current=await Task.Run(()=>Detection.Read(target));
    if(!current.Single(x=>x.Key==dependency.Key).Compatible)throw new InvalidOperationException(dependency.Name+"安装后检查未通过。"+(restart!=0?"请重启 Windows 后重试。":"请查看详情，确认官方安装成功后重试。"));
   }
   token.ThrowIfCancellationRequested();progress("正在复查全部运行环境…");
   if(!(await Task.Run(()=>Detection.Read(target))).All(x=>x.Compatible))throw new InvalidOperationException("运行环境复查未通过，尚未开始安装应用。");
   canCancel(true);token.ThrowIfCancellationRequested();
   string cache=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLight","SetupLogs",DateTime.Now.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N").Substring(0,8));
   Directory.CreateDirectory(cache);string package=Path.Combine(cache,"CodexLight.msi"),log=Path.Combine(cache,"install.log");
   // Extract only the embedded MSI. Windows Installer owns every installed application file.
   using(var input=Assembly.GetExecutingAssembly().GetManifestResourceStream("CodexLight.Application.msi")){
    if(input==null)throw new InvalidOperationException("安装包缺少嵌入的 MSI。");
    using(var output=new FileStream(package,FileMode.CreateNew,FileAccess.Write,FileShare.None))await input.CopyToAsync(output,65536,token);
   }
   token.ThrowIfCancellationRequested();canCancel(false);progress("正在安装 Codex Light…"+Environment.NewLine+"Windows Installer 日志："+log);
   try{
    using(var process=Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"msiexec.exe"),MsiArguments(package,target,log)){UseShellExecute=false,CreateNoWindow=true})){
     if(process==null)throw new InvalidOperationException("Windows Installer 未启动。");await Task.Run(()=>process.WaitForExit());ExitCodePolicy.RequireSuccess(process.ExitCode,"Codex Light");return process.ExitCode==0?restart:process.ExitCode;
    }
   }catch(Win32Exception e)when(e.NativeErrorCode==1223){throw new OperationCanceledException("系统授权已取消。",e);}
   finally{progress("安装日志保留在："+cache);}
  }
 }
}
