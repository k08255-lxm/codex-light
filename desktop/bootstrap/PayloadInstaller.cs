using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;
namespace CodexLight.Bootstrap {
 [DataContract]internal sealed class PayloadFile{[DataMember(Name="path")]public string Path="";[DataMember(Name="sha256")]public string Hash="";[DataMember(Name="size")]public long Size=0;}
 [DataContract]internal sealed class PayloadManifest{[DataMember(Name="files")]public List<PayloadFile> Files=new List<PayloadFile>();}
 internal static class PayloadInstaller {
  public static bool Available=>Assembly.GetExecutingAssembly().GetManifestResourceNames().Contains("CodexLight.PayloadManifest");
  internal static PayloadManifest Manifest(){using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("CodexLight.PayloadManifest")){if(stream==null)throw new InvalidOperationException("此版本只用于环境准备，未包含软件安装清单。");var manifest=(PayloadManifest)new DataContractJsonSerializer(typeof(PayloadManifest)).ReadObject(stream)!;if(manifest.Files.Count==0||manifest.Files.Count>3000||manifest.Files.Select(x=>x.Path).Distinct(StringComparer.OrdinalIgnoreCase).Count()!=manifest.Files.Count)throw new InvalidOperationException("软件清单格式无效。");return manifest;}}
  static string SafePath(string root,string relative){
   if(string.IsNullOrWhiteSpace(relative)||System.IO.Path.IsPathRooted(relative)||relative.IndexOf(':')>=0||relative.Split('/','\\').Any(x=>x==".."||x=="."||x.Length==0))throw new InvalidOperationException("拒绝清单中的无效路径。");
   string full=System.IO.Path.GetFullPath(System.IO.Path.Combine(root,relative.Replace('/',System.IO.Path.DirectorySeparatorChar)));string prefix=System.IO.Path.GetFullPath(root).TrimEnd('\\','/')+System.IO.Path.DirectorySeparatorChar;
   if(!full.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("清单路径超出程序目录。");return full;
  }
  static void NoReparsePath(string path){var current=new DirectoryInfo(System.IO.Path.GetDirectoryName(path)!);while(current!=null){if(current.Exists&&(current.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("拒绝经过目录链接的程序路径。");current=current.Parent;}}
  static string Hash(string path,long? expected=null)=>BoundedFile.Hash(path,expected??new FileInfo(path).Length);
  static string Registration(string directory){using(var hash=SHA256.Create())return @"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexLight-"+BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(directory.ToLowerInvariant()))).Replace("-","").Substring(0,16);}
  public static void Install(string destination){
   using var maintenance=CodexLight.Shared.InstallMaintenance.Acquire(destination);
   string target=System.IO.Path.GetFullPath(destination).TrimEnd('\\','/');NoReparsePath(System.IO.Path.Combine(target,"probe"));if(Directory.Exists(target)&&Directory.EnumerateFileSystemEntries(target).Any())throw new InvalidOperationException("请选择空目录。不会覆盖已有安装或用户文件。");
   var manifest=Manifest();string source=System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"payload");
   // Validate the entire release before creating any destination program files.
   foreach(var item in manifest.Files){string file=SafePath(source,item.Path);NoReparsePath(file);if(!File.Exists(file)||(File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0||new FileInfo(file).Length!=item.Size||!string.Equals(Hash(file,item.Size),item.Hash,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("软件文件缺失或校验不匹配："+item.Path);}
   string parent=System.IO.Path.GetDirectoryName(target)??throw new InvalidOperationException("不允许安装到根目录。");Directory.CreateDirectory(parent);
   string staging=System.IO.Path.Combine(parent,"CodexLight.installing-"+Guid.NewGuid().ToString("N"));bool committed=false;
   try{
    Directory.CreateDirectory(staging);
    foreach(var item in manifest.Files){string file=SafePath(staging,item.Path);Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file)!);BoundedFile.Copy(SafePath(source,item.Path),file,item.Size);if(new FileInfo(file).Length!=item.Size||!string.Equals(Hash(file,item.Size),item.Hash,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("复制后校验失败："+item.Path);}
    // This exe carries the immutable original ownership manifest for safe uninstall.
    File.Copy(Assembly.GetExecutingAssembly().Location,System.IO.Path.Combine(staging,"Uninstall.exe"),false);
    File.WriteAllText(System.IO.Path.Combine(staging,"Uninstall.exe.config"),"<configuration><startup><supportedRuntime version=\"v4.0\" sku=\".NETFramework,Version=v4.8\" /></startup></configuration>");
    var ownedFiles=manifest.Files.Select(f=>new UpgradeFile(f.Path,f.Size,f.Hash)).ToList();
    foreach(var name in new[]{"Uninstall.exe","Uninstall.exe.config"}){var ownedPath=System.IO.Path.Combine(staging,name);ownedFiles.Add(new UpgradeFile(name,new FileInfo(ownedPath).Length,Hash(ownedPath)));}
    var receipt=new InstallReceipt(Guid.NewGuid().ToString("D"),target,ownedFiles);
    File.WriteAllBytes(System.IO.Path.Combine(staging,UpgradeReceiptCodec.Filename),UpgradeReceiptCodec.Encode(receipt));
    NoReparsePath(System.IO.Path.Combine(target,"probe"));
    if(Directory.Exists(target)){if(Directory.EnumerateFileSystemEntries(target).Any())throw new InvalidOperationException("目标目录已出现文件，已停止，不会覆盖。");Directory.Delete(target);}
    Directory.Move(staging,target);committed=true;
    string uninstall=System.IO.Path.Combine(target,"Uninstall.exe");
    try{using(var key=Registry.CurrentUser.CreateSubKey(Registration(target))){key!.SetValue("DisplayName","Codex Light");key.SetValue("UninstallString","\""+uninstall+"\" /uninstall");key.SetValue("InstallLocation",target);key.SetValue("InstallId",receipt.InstallId);key.SetValue("ReceiptHash",receipt.Fingerprint());key.SetValue("NoModify",1);key.SetValue("NoRepair",1);}}catch(Exception e){throw new InvalidOperationException("程序文件已完整安装，但系统卸载登记失败。安全卸载将拒绝未登记目录；请保留此安装路径，人工检查后将程序文件移到回收站，不要删除用户数据。"+e.Message);}
   }finally{if(!committed&&Directory.Exists(staging))Directory.Delete(staging,true);}

  }
  public static string Uninstall(){
   string target=System.IO.Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\','/');
   string expected=System.IO.Path.Combine(target,"Uninstall.exe");
   string actual=System.IO.Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
   if(!string.Equals(actual,expected,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("拒绝卸载：请运行安装目录中登记的 Uninstall.exe，不能从安装包或任意目录删除程序文件。");
   NoReparsePath(expected);
   if((File.GetAttributes(expected)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("拒绝卸载：卸载器不能是文件链接。");
   using(var registration=Registry.CurrentUser.OpenSubKey(Registration(target),false)){
    string? location=registration?.GetValue("InstallLocation",null,RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
    string? command=registration?.GetValue("UninstallString",null,RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
    if(!string.Equals(location,target,StringComparison.OrdinalIgnoreCase)||!string.Equals(command,"\""+expected+"\" /uninstall",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("拒绝卸载：当前用户安装登记缺失或与此目录不匹配，未删除任何文件。");
   }
   var manifest=Manifest();int removed=0,retained=0;
   if(System.Diagnostics.Process.GetProcessesByName("CodexLight").Any())throw new InvalidOperationException("请先退出 Codex Light，再卸载。不会强制终止工作任务。");
   foreach(var item in manifest.Files){string file=SafePath(target,item.Path);NoReparsePath(file);if(!File.Exists(file))continue;if((File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0||new FileInfo(file).Length!=item.Size||!string.Equals(Hash(file,item.Size),item.Hash,StringComparison.OrdinalIgnoreCase)){retained++;continue;}File.Delete(file);removed++;}
   foreach(var dir in manifest.Files.Select(x=>System.IO.Path.GetDirectoryName(SafePath(target,x.Path))).Where(x=>x!=null).Distinct().OrderByDescending(x=>x!.Length)){if(dir!=target&&Directory.Exists(dir)&&!Directory.EnumerateFileSystemEntries(dir).Any())Directory.Delete(dir);}
   Registry.CurrentUser.DeleteSubKeyTree(Registration(target),false);
   return "已移除 "+removed+" 个未修改的自有程序文件，保留 "+retained+" 个修改文件及所有未知文件。\n共享 .NET、Node、WebView2、Codex 配置/会话和项目未删除。\n正在运行的 Uninstall.exe 及其配置文件会保留，关闭此窗口后可手动移到回收站。";
  }
 }
}
