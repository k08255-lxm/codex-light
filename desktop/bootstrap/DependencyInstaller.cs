using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Threading;
namespace CodexLight.Bootstrap {
 internal static class DependencyInstaller {
  static LockedDependency Locked(string key){var assembly=Assembly.GetExecutingAssembly();using(var stream=assembly.GetManifestResourceStream(assembly.GetManifestResourceNames().Single(x=>x.EndsWith("dependencies.lock.json",StringComparison.Ordinal)))){var root=(DependencyLock)new DataContractJsonSerializer(typeof(DependencyLock)).ReadObject(stream)!;switch(key){case "dotnet":return root.Dotnet;case "node":return root.Node;case "webview":return root.Webview;default:throw new InvalidOperationException("未知依赖");}}}
  static bool Official(Uri uri)=>uri.Scheme=="https"&&(uri.Host=="nodejs.org"||uri.Host=="go.microsoft.com"||uri.Host.EndsWith(".microsoft.com",StringComparison.OrdinalIgnoreCase)||uri.Host=="dotnetcli.azureedge.net");
  public static async Task Install(string key,Action<string> progress,CancellationToken cancellation,Action<bool> allowCancel){await Install(key,progress,cancellation,allowCancel,false);}
  internal static string PassiveArguments(string key,string file){switch(key){case "node":return "/i \""+file+"\" /passive /norestart";case "dotnet":return "/install /passive /norestart";case "webview":return "/silent /install";default:throw new InvalidOperationException("未知依赖");}}
  public static async Task<int> Install(string key,Action<string> progress,CancellationToken cancellation,Action<bool> allowCancel,bool passive,Action<long,long?>? downloadProgress=null){
   allowCancel(true);cancellation.ThrowIfCancellationRequested();
   var locked=Locked(key);if(!Uri.TryCreate(locked.Url,UriKind.Absolute,out var uri)||!Official(uri))throw new InvalidOperationException("下载地址不在官方白名单内。");
   var directory=Path.Combine(Path.GetTempPath(),"CodexLight-Dependency-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);var file=Path.Combine(directory,key+(key=="node"?".msi":".exe"));
   try{
    progress("下载官方依赖（仅 HTTPS）："+uri.GetLeftPart(UriPartial.Path));
    using(var deadline=CancellationTokenSource.CreateLinkedTokenSource(cancellation)){
     deadline.CancelAfter(TimeSpan.FromMinutes(5));var downloadToken=deadline.Token;
     try{
      using(var client=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=Timeout.InfiniteTimeSpan}){
       for(int redirects=0;;redirects++){
        using(var response=await client.GetAsync(uri,HttpCompletionOption.ResponseHeadersRead,downloadToken))
        using(downloadToken.Register(()=>response.Dispose())){
         if((int)response.StatusCode>=300&&(int)response.StatusCode<400){if(redirects>=8||response.Headers.Location==null)throw new InvalidOperationException("官方重定向无效。");uri=new Uri(uri,response.Headers.Location);if(!Official(uri))throw new InvalidOperationException("拒绝非官方或非 HTTPS 重定向。");continue;}
         response.EnsureSuccessStatusCode();long? length=response.Content.Headers.ContentLength;if(length>200*1024*1024)throw new InvalidOperationException("依赖下载超出大小上限。");
         using(var input=await response.Content.ReadAsStreamAsync())using(var output=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None)){
          byte[] buffer=new byte[65536];long total=0,lastReported=0;int count;var clock=Stopwatch.StartNew();
          Action report=()=>{progress("下载进度："+(total/1048576d).ToString("F1")+" MiB"+(length.HasValue?" / "+(length.Value/1048576d).ToString("F1")+" MiB":"（总大小未知）"));downloadProgress?.Invoke(total,length);};
          downloadProgress?.Invoke(0,length);
          while((count=await input.ReadAsync(buffer,0,buffer.Length,downloadToken))>0){
           total+=count;if(total>200*1024*1024)throw new InvalidOperationException("依赖下载超出大小上限。");await output.WriteAsync(buffer,0,count,downloadToken);
           if(total-lastReported>=5*1024*1024||clock.ElapsedMilliseconds>=1000){report();lastReported=total;clock.Restart();}
          }
          downloadToken.ThrowIfCancellationRequested();if(total!=lastReported)report();
         }
         break;
        }
       }
      }
     }catch(Exception e) when(deadline.IsCancellationRequested){
      if(cancellation.IsCancellationRequested)throw new OperationCanceledException("用户已取消下载，未执行待安装文件。",e,cancellation);
      throw new TimeoutException("下载超过 5 分钟总时限（包括响应正文），已停止且未执行文件。",e);
     }
    }
    progress("核验固定哈希及 Windows 代码签名…");
    await Task.Run(()=>{
     using(HashAlgorithm hash=locked.Algorithm=="SHA512"?(HashAlgorithm)SHA512.Create():locked.Algorithm=="SHA256"?SHA256.Create():throw new InvalidOperationException("未知哈希算法"))using(var stream=File.OpenRead(file)){
      if(!string.Equals(BitConverter.ToString(hash.ComputeHash(stream)).Replace("-",""),locked.Hash,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("依赖哈希不匹配，未执行任何文件。官方文件更新时需重新审核并发布安装器。");
     }
     cancellation.ThrowIfCancellationRequested();Signature.Verify(file);cancellation.ThrowIfCancellationRequested();
     using(var certificate=new X509Certificate2(X509Certificate.CreateFromSignedFile(file))){string pattern=key=="node"?@"(^|,\s*)O=(OpenJS Foundation|Node\.js Foundation)(,|$)":@"(^|,\s*)O=Microsoft Corporation(,|$)";if(!Regex.IsMatch(certificate.Subject,pattern))throw new InvalidOperationException("签名发布者不是预期官方组织，未执行。");}
    });
    cancellation.ThrowIfCancellationRequested();allowCancel(false);
    progress(passive?"正在安装已验证的官方运行时，请等待系统授权或安装完成…":"验证通过，等待官方安装程序。可在其界面取消；不会静默选择许可或附加组件。");
    var start=new ProcessStartInfo(key=="node"?Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"msiexec.exe"):file){UseShellExecute=true};if(key=="node")start.Arguments="/i \""+file+"\"";
    if(passive)start.Arguments=PassiveArguments(key,file);
    using(var process=Process.Start(start)){if(process==null)throw new InvalidOperationException("官方安装程序未启动。");await Task.Run(()=>process.WaitForExit());if(process.ExitCode==1602)throw new OperationCanceledException("官方安装已取消（1602）。");if(process.ExitCode!=0&&process.ExitCode!=3010&&process.ExitCode!=1641)throw new InvalidOperationException("官方安装失败，退出码 "+process.ExitCode+"。");return process.ExitCode;}
   }catch(System.ComponentModel.Win32Exception e) when(e.NativeErrorCode==1223){throw new OperationCanceledException("系统授权已取消。",e,cancellation);}
   finally{allowCancel(false);try{Directory.Delete(directory,true);}catch{/* only own temporary download; locked vendor files may remain */}}
  }
 }
 internal static class Signature {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct FileInfo{public uint Size;[MarshalAs(UnmanagedType.LPWStr)]public string Path;public IntPtr File,Subject;}
  [StructLayout(LayoutKind.Sequential)]struct TrustData{public uint Size;public IntPtr Callback,Client;public uint UI,Revocation,Choice;public IntPtr File;public uint Action;public IntPtr State,URL;public uint Flags,Context;}
  public static void Verify(string file){
   var info=new FileInfo{Size=(uint)Marshal.SizeOf(typeof(FileInfo)),Path=file};var pointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));Marshal.StructureToPtr(info,pointer,false);
   var data=new TrustData{Size=(uint)Marshal.SizeOf(typeof(TrustData)),UI=2,Revocation=1,Choice=1,File=pointer,Action=1};var action=new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
   try{int result=WinVerifyTrust(IntPtr.Zero,ref action,ref data);if(result!=0)throw new InvalidOperationException("Windows 签名验证失败：0x"+result.ToString("X8")+"。未执行。");}
   finally{data.Action=2;WinVerifyTrust(IntPtr.Zero,ref action,ref data);Marshal.DestroyStructure(pointer,typeof(FileInfo));Marshal.FreeHGlobal(pointer);}
  }
  [DllImport("wintrust.dll",ExactSpelling=true,PreserveSig=true)]static extern int WinVerifyTrust(IntPtr window,ref Guid action,ref TrustData data);
 }
}
