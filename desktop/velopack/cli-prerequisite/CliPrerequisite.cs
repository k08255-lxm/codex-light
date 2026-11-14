using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.InteropServices;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
namespace CodexLight.Prerequisites {
 public enum CliState { Ready, Missing, Uncertain }
 public sealed class CliDetection {public CliState State {get;}public string? Path {get;}public string? Version {get;}public string Detail {get;}public CliDetection(CliState state,string? path,string? version,string detail){State=state;Path=path;Version=version;Detail=detail;}}
 [DataContract] public sealed class CliReceipt {
  [DataMember(Name="version",IsRequired=true)]public string Version="";
  [DataMember(Name="relativeExecutable",IsRequired=true)]public string RelativeExecutable="";
  [DataMember(Name="sha256",IsRequired=true)]public string Sha256="";
  [DataMember(Name="packageIntegrity",IsRequired=true)]public string PackageIntegrity="";
 }
 public static class CliPrerequisite {
  public const string PinnedVersion="0.169.0";
  public const string PackageUrl="https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-win32-x64.tgz";
  public const string Integrity="sha512-nC+McFU8xRNL9tk3IhxcKdhcyOElwF/HhPO+gzSQCY7yjh3XdzSajX+MYWcHUVHWRHajfwn3/WgJYJK2wS+XWg==";
  public const long ArchiveBytes=187002407,ExpandedBytes=515178111;
  public const string ExecutableRelative="package/vendor/x86_64-pc-windows-msvc/bin/codex.exe";
  public const string ExecutableSha256="ce1945eb440b5481ed1233ebaf32b7056ee7e4e452fa62ffe1cbfb26103cdee0";
  public static string ToolsRoot{get{string root=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLightTools","codex");if(!Regex.IsMatch(root,@"^[A-Za-z]:\\"))throw new IOException("Local tools root required");return root;}}
   [StructLayout(LayoutKind.Sequential)]struct SystemInfo{public ushort Architecture,Reserved;public uint PageSize;public IntPtr Minimum,Maximum;public UIntPtr Mask;public uint Processors,ProcessorType,Granularity;public ushort Level,Revision;}
  [DllImport("kernel32.dll")]static extern void GetNativeSystemInfo(out SystemInfo info);
  public static bool NativeX64(){try{GetNativeSystemInfo(out var info);return info.Architecture==9;}catch{return false;}}
 public static CliDetection Detect(){
   if(!NativeX64())return new CliDetection(CliState.Uncertain,null,null,"Only Windows x64 is supported by this pinned CLI installer.");
   bool uncertain=false;var candidates=new List<string>();string roaming=Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
   candidates.Add(System.IO.Path.Combine(roaming,@"npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"));
   candidates.Add(System.IO.Path.Combine(roaming,@"npm\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\codex\codex.exe"));
   string? explicitPath=Environment.GetEnvironmentVariable("CODEX_LIGHT_CODEX");if(!string.IsNullOrWhiteSpace(explicitPath)){
    if(!System.IO.Path.IsPathRooted(explicitPath)||!explicitPath.EndsWith(".exe",StringComparison.OrdinalIgnoreCase))return new CliDetection(CliState.Uncertain,null,null,"Configured CLI path is not a native absolute executable.");
    if(!File.Exists(explicitPath))return new CliDetection(CliState.Uncertain,null,null,"Configured CLI not found; configuration was not changed.");
    string? configuredVersion=Probe(explicitPath!);return configuredVersion==null?new CliDetection(CliState.Uncertain,null,null,"Configured CLI version could not be verified."):new CliDetection(CliState.Ready,explicitPath,configuredVersion,"Reusing explicitly configured native CLI.");
   }
   try{
    string powershell=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe");
    string? locations=Run(powershell,"-NoLogo -NoProfile -NonInteractive -Command \"Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation\"");
    if(locations==null)uncertain=true;else foreach(string line in locations.Split(new[]{'\r','\n'},StringSplitOptions.RemoveEmptyEntries)){
     string location=line.Trim();if(System.IO.Path.IsPathRooted(location)&&Regex.IsMatch(System.IO.Path.GetFileName(location),@"^OpenAI\.Codex_[A-Za-z0-9._-]+$",RegexOptions.IgnoreCase))candidates.Add(System.IO.Path.Combine(location,@"app\resources\codex.exe"));
    }
   }catch{uncertain=true;}
   foreach(string candidate in candidates){if(!File.Exists(candidate)){if(candidate==explicitPath)uncertain=true;continue;}string? version=Probe(candidate);if(version!=null)return new CliDetection(CliState.Ready,candidate,version,"Reusing existing native Codex CLI; no account or model request made.");uncertain=true;}
   try{var installed=DetectPrivate();if(installed!=null)return installed;}catch{uncertain=true;}
   return new CliDetection(uncertain?CliState.Uncertain:CliState.Missing,null,null,uncertain?"Existing CLI could not be verified. No existing files were changed.":"Native Codex CLI not found.");
  }
  public static bool Compatible(string value){var m=Regex.Match(value,@"^([0-9]+\.[0-9]+\.[0-9]+)(?:-[0-9A-Za-z.-]+)?$");return m.Success&&System.Version.TryParse(m.Groups[1].Value,out var v);}
  public static string? Probe(string executable){string? output=Run(executable,"--version");if(output==null)return null;var match=Regex.Match(output.Trim(),@"^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$");return match.Success&&Compatible(match.Groups[1].Value)?match.Groups[1].Value:null;}
  static string? Run(string executable,string args){
   using(var p=new Process{StartInfo=new ProcessStartInfo(executable,args){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,RedirectStandardOutput=true,RedirectStandardError=true}}){
    try{if(!p.Start())return null;Func<StreamReader,string> read=r=>{var b=new char[1024];var result=new StringBuilder();int n;while((n=r.Read(b,0,b.Length))>0){if(result.Length+n>65536)throw new InvalidDataException();result.Append(b,0,n);}return result.ToString();};var stdout=Task.Run(()=>read(p.StandardOutput));var stderr=Task.Run(()=>read(p.StandardError));if(!p.WaitForExit(5000)||!Task.WaitAll(new Task[]{stdout,stderr},5000)||p.ExitCode!=0)return null;return stdout.Result;}
    catch{return null;}finally{try{if(!p.HasExited)p.Kill();}catch{}}
   }
  }
  static CliDetection? DetectPrivate(){
   string receiptFile=System.IO.Path.Combine(ToolsRoot,"current.json");if(!File.Exists(receiptFile)){if(Directory.Exists(System.IO.Path.Combine(ToolsRoot,PinnedVersion)))throw new InvalidDataException("Incomplete private CLI installation");return null;}CheckExistingPath(receiptFile);if(new FileInfo(receiptFile).Length>4096)throw new InvalidDataException();CliReceipt receipt;using(var f=File.OpenRead(receiptFile))receipt=(CliReceipt)(new DataContractJsonSerializer(typeof(CliReceipt)).ReadObject(f)??throw new InvalidDataException());
   if(receipt.Version!=PinnedVersion||receipt.RelativeExecutable!=ExecutableRelative||receipt.Sha256!=ExecutableSha256||receipt.PackageIntegrity!=Integrity)throw new InvalidDataException();
   string exe=System.IO.Path.Combine(ToolsRoot,PinnedVersion,ExecutableRelative.Replace('/',System.IO.Path.DirectorySeparatorChar));CheckExistingPath(exe);if(Hash(exe)!=ExecutableSha256)throw new InvalidDataException();if(Probe(exe)!=PinnedVersion)throw new InvalidDataException();return new CliDetection(CliState.Ready,exe,PinnedVersion,"Using verified app-private Codex CLI.");
  }
  public static async Task<int> InstallAsync(IProgress<string>? progress,CancellationToken cancellationToken){
   using(var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancellationToken)){timeout.CancelAfter(TimeSpan.FromMinutes(20));cancellationToken=timeout.Token;
   string? stage=null;
   try{
    cancellationToken.ThrowIfCancellationRequested();if(!NativeX64())return 1603;
    CheckedDirectory(ToolsRoot);string target=System.IO.Path.Combine(ToolsRoot,PinnedVersion),receiptPath=System.IO.Path.Combine(ToolsRoot,"current.json");
    if(File.Exists(System.IO.Path.Combine(ToolsRoot,".install-lock")))CheckExistingPath(System.IO.Path.Combine(ToolsRoot,".install-lock"));
    using(var installLock=new FileStream(System.IO.Path.Combine(ToolsRoot,".install-lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)){
     CheckExistingPath(System.IO.Path.Combine(ToolsRoot,".install-lock"));if(File.Exists(receiptPath))return DetectPrivate()!=null?0:1603;if(Directory.Exists(target))return 1603;
     var drive=new DriveInfo(System.IO.Path.GetPathRoot(ToolsRoot)??throw new IOException());if(drive.AvailableFreeSpace<ArchiveBytes+ExpandedBytes+128L*1024*1024)throw new IOException("Insufficient disk space");
     stage=System.IO.Path.Combine(ToolsRoot,".stage-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(stage);CheckedDirectory(stage);string archive=System.IO.Path.Combine(stage,"platform.tgz"),payload=System.IO.Path.Combine(stage,"payload");Directory.CreateDirectory(payload);
     progress?.Report("Downloading pinned official Codex CLI (no npm scripts).");
     using(var handler=new HttpClientHandler{AllowAutoRedirect=false})using(var client=new HttpClient(handler){Timeout=TimeSpan.FromMinutes(20)})using(var response=await client.GetAsync(PackageUrl,HttpCompletionOption.ResponseHeadersRead,cancellationToken).ConfigureAwait(false)){
      if(response.StatusCode!=HttpStatusCode.OK||response.Content.Headers.ContentLength.HasValue&&response.Content.Headers.ContentLength.Value!=ArchiveBytes)throw new InvalidDataException("Unexpected official package response");
      using(var input=await response.Content.ReadAsStreamAsync().ConfigureAwait(false))using(var output=new FileStream(archive,FileMode.CreateNew,FileAccess.Write,FileShare.None))using(var sha=SHA512.Create()){
       var bytes=new byte[65536];long total=0;int n;while((n=await input.ReadAsync(bytes,0,bytes.Length,cancellationToken).ConfigureAwait(false))>0){total+=n;if(total>ArchiveBytes)throw new InvalidDataException("Package too large");sha.TransformBlock(bytes,0,n,null,0);await output.WriteAsync(bytes,0,n,cancellationToken).ConfigureAwait(false);}sha.TransformFinalBlock(new byte[0],0,0);output.Flush(true);
       VerifyDownload(total,sha.Hash??throw new InvalidDataException());
      }
     }
     progress?.Report("Verifying and extracting official Codex CLI.");
     using(var input=File.OpenRead(archive)){long bytes=SafeTar.Extract(input,payload,ExpandedBytes,64,cancellationToken);if(bytes!=ExpandedBytes)throw new InvalidDataException("Package expanded size mismatch");}
     string stagedExe=System.IO.Path.Combine(payload,ExecutableRelative.Replace('/',System.IO.Path.DirectorySeparatorChar));CheckExistingPath(stagedExe);if(Hash(stagedExe)!=ExecutableSha256||Probe(stagedExe)!=PinnedVersion)throw new InvalidDataException("CLI verification failed");cancellationToken.ThrowIfCancellationRequested();
     WriteLicenses(payload);CheckedDirectory(ToolsRoot);Directory.Move(payload,target);
     var receipt=new CliReceipt{Version=PinnedVersion,RelativeExecutable=ExecutableRelative,Sha256=ExecutableSha256,PackageIntegrity=Integrity};string pending=System.IO.Path.Combine(stage,"current.json");using(var f=new FileStream(pending,FileMode.CreateNew,FileAccess.Write,FileShare.None)){new DataContractJsonSerializer(typeof(CliReceipt)).WriteObject(f,receipt);f.Flush(true);}File.Move(pending,receiptPath);
     // Successful stage contains only our verified archive. Leave failed/ambiguous stages untouched.
     CheckExistingPath(archive);File.Delete(archive);Directory.Delete(stage);stage=null;progress?.Report("Codex CLI ready. Account sign-in remains under your control.");return 0;
    }
   }catch(OperationCanceledException){return 1602;}catch{return 1603;}
   }
  }
  public static void CheckExistingPath(string target){for(string? p=System.IO.Path.GetFullPath(target);p!=null;p=System.IO.Path.GetDirectoryName(p))if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("Reparse path refused");}
  public static void CheckedDirectory(string target){var stack=new Stack<string>();for(string? p=System.IO.Path.GetFullPath(target);p!=null;p=System.IO.Path.GetDirectoryName(p))stack.Push(p);while(stack.Count>0){string p=stack.Pop();if(!Directory.Exists(p))Directory.CreateDirectory(p);if((File.GetAttributes(p)&(FileAttributes.ReparsePoint|FileAttributes.Directory))!=FileAttributes.Directory)throw new IOException("Unsafe tools directory");}}
  public static void VerifyDownload(long bytes,byte[] hash){if(bytes!=ArchiveBytes||"sha512-"+Convert.ToBase64String(hash)!=Integrity)throw new InvalidDataException("Package integrity mismatch");}
  static void WriteLicenses(string payload){
   string folder=System.IO.Path.Combine(payload,"codex-light-notices");CheckedDirectory(folder);
   foreach(string name in new[]{"LICENSE","NOTICE"})using(var source=typeof(CliPrerequisite).Assembly.GetManifestResourceStream("CodexCli."+name)??throw new InvalidDataException("Missing upstream license"))using(var output=new FileStream(System.IO.Path.Combine(folder,name),FileMode.CreateNew,FileAccess.Write,FileShare.None)){source.CopyTo(output);output.Flush(true);}
  }
  static string Hash(string file){using(var f=File.OpenRead(file))using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(f)).Replace("-","").ToLowerInvariant();}
 }
}
