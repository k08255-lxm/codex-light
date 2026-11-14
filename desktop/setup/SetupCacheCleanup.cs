using System;
using System.IO;
using System.Linq;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
namespace CodexLight.Bootstrap {
 // Cleanup is deliberately fail-closed. Windows Installer owns its system cache.
 internal static class SetupCacheCleanup {
  internal static bool PlainPath(string value) {
   for(string? p=Path.GetFullPath(value);p!=null;p=Path.GetDirectoryName(p))
    if((File.Exists(p)||Directory.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)return false;
   return true;
  }
  internal static bool Same(string a,string b)=>string.Equals(Path.GetFullPath(a).TrimEnd('\\'),Path.GetFullPath(b).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase);
  static string Info(string product,string property){uint n=32767;var s=new StringBuilder((int)n);if(MsiGetProductInfo(product,property,s,ref n)!=0)throw new IOException("Cannot verify installed MSI source.");return s.ToString();}
  internal static bool CurrentMatches(EmbeddedPackage current,string target,bool installed,string version,string location,string source) {
   try{return installed&&version==current.Version&&!string.IsNullOrWhiteSpace(location)&&!string.IsNullOrWhiteSpace(source)&&Same(location,target)&&Same(source,Path.GetDirectoryName(current.Path)!);}catch{return false;}
  }
  static bool VerifiedCurrent(EmbeddedPackage current,string target) {
   if(!CurrentMatches(current,target,current.InstalledForCurrentUser(),Info(current.ProductCode,"VersionString"),Info(current.ProductCode,"InstallLocation"),Info(current.ProductCode,"InstallSource")))return false;
   var code=new StringBuilder(39);if(MsiEnumRelatedProducts(InstallPaths.UpgradeCode,0,0,code)!=0||!string.Equals(code.ToString(),current.ProductCode,StringComparison.OrdinalIgnoreCase))return false;
   return MsiEnumRelatedProducts(InstallPaths.UpgradeCode,0,1,new StringBuilder(39))==259;
  }
  internal static string[] Candidates(string root,string currentDirectory,Version currentVersion,Func<string,bool> ownedMsi,Func<string,bool> ownedSetup) {
   if(!Directory.Exists(root)||!PlainPath(root))return Array.Empty<string>();
   return Directory.EnumerateDirectories(root).Where(dir=>{
    try {
     if(Same(dir,currentDirectory)||!PlainPath(dir)||Directory.EnumerateDirectories(dir).Any())return false;
     var files=Directory.GetFiles(dir);if(files.Length==0||files.Any(f=>!PlainPath(f)))return false;
     var name=Path.GetFileName(dir);
     if(Regex.IsMatch(name,@"^\d{8}-\d{6}-[a-f0-9]{8}$")){
      var msi=files.Where(f=>Regex.IsMatch(Path.GetFileName(f),@"^CodexLight-\d+\.\d+\.\d+-x64\.msi$")).ToArray();
      if(msi.Length!=1||files.Any(f=>f!=msi[0]&&!new[]{"install.log","install.log.gz","result.txt","log-policy.txt"}.Contains(Path.GetFileName(f),StringComparer.Ordinal)))return false;
      return ownedMsi(msi[0]);
     }
     var match=Regex.Match(name,@"^(\d+\.\d+\.\d+)-([a-f0-9]{16})$");
     if(!match.Success||!Version.TryParse(match.Groups[1].Value,out var version)||version>=currentVersion||files.Length!=1||Path.GetFileName(files[0])!="CodexLight-Setup.exe")return false;
     return ownedSetup(files[0]);
    }catch{return false;}
   }).ToArray();
  }
  internal static void Run(int combinedExitCode,EmbeddedPackage current,string target,Action<string> report) {
   if(combinedExitCode!=0)return; // Includes prerequisite and MSI reboot requirements.
   string root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLight");
   if(!PlainPath(root)||!VerifiedCurrent(current,target)) {report("Old setup caches retained: current MSI/source verification did not pass.");return;}
   string keep=Path.GetDirectoryName(current.Path)!;
   Func<string,bool> ownedMsi=file=>{
    var old=EmbeddedPackage.Read(file); // Verifies our exact UpgradeCode, without executing it.
    return Version.Parse(old.Version)<Version.Parse(current.Version)&&MsiQueryProductState(old.ProductCode)==-1;
   };
   Func<string,bool> ownedSetup=file=>{
    var info=FileVersionInfo.GetVersionInfo(file);
    if(info.ProductName!="Codex Light"||!Version.TryParse(info.FileVersion,out var v)||v>=Version.Parse(current.Version))return false;
    using(var stream=File.OpenRead(file))using(var sha=SHA256.Create()){
     var hash=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
     return Path.GetFileName(Path.GetDirectoryName(file)!).EndsWith("-"+hash.Substring(0,16),StringComparison.Ordinal);
    }
   };
   int moved=0;
   foreach(string cache in new[]{Path.Combine(root,"SetupLogs"),Path.Combine(root,"Updates")})
    foreach(string dir in Candidates(cache,keep,Version.Parse(current.Version),ownedMsi,ownedSetup)) {
     // Recheck ownership/source immediately before the Shell operation. Unknown/locked items stay.
     if(!VerifiedCurrent(current,target)||!Candidates(cache,keep,Version.Parse(current.Version),ownedMsi,ownedSetup).Contains(dir))continue;
     try{RecoverableArchive.Archive(dir,Path.Combine(root,"SetupArchives"));moved++;}catch(Exception e){report("Old setup cache retained: "+e.Message);}
    }
   report("Archived "+moved+" old Codex Light setup cache(s) losslessly under SetupArchives. Use each archive Restore.ps1 to recover. Archives are retained; only compression saves space. Current MSI source and Windows Installer cache were retained.");
  }
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiGetProductInfo(string product,string property,StringBuilder value,ref uint length);
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiEnumRelatedProducts(string upgradeCode,int reserved,int index,StringBuilder productCode);
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern int MsiQueryProductState(string productCode);
 }
}
