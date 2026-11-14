using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Globalization;
using System.Text.RegularExpressions;
namespace CodexLight.Bootstrap {
 internal static class SetupLogs {
  const string Marker = "codex-light-success-log-v1";
  internal static bool Verbose => Environment.GetEnvironmentVariable("CODEX_LIGHT_SETUP_VERBOSE") == "1";
  internal static string Switch(bool verbose) => verbose ? "/L*v" : "/Lweamo";
  static bool Plain(string path) => (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0;
  // Only logs created by this policy are pruned. MSI source packages and old logs are never removed.
  internal static void Complete(string directory, int code, long milliseconds, bool verbose, DateTime now) {
   if (!Plain(directory)) throw new IOException("Log directory is a reparse point.");
   string summary=Path.Combine(directory,"result.txt");
   using(var writer=new StreamWriter(new FileStream(summary,FileMode.CreateNew,FileAccess.Write,FileShare.None))) {
    writer.WriteLine("Codex Light installer result"); writer.WriteLine("exitCode="+code);
    writer.WriteLine("msiElapsedMs="+milliseconds); writer.WriteLine("verbose="+verbose);
    writer.WriteLine("completedUtc="+now.ToUniversalTime().ToString("o",CultureInfo.InvariantCulture));
   }
   if(!ExitCodePolicy.IsSuccess(code)) return; // Preserve failed/cancelled diagnostics, never rerun installation.
   string log=Path.Combine(directory,"install.log"), archive=log+".gz";
   if(!File.Exists(log)||!Plain(log)) return;
   using(var input=new FileStream(log,FileMode.Open,FileAccess.Read,FileShare.Read))
   using(var output=new FileStream(archive,FileMode.CreateNew,FileAccess.Write,FileShare.None))
   using(var compressed=new GZipStream(output,CompressionLevel.Optimal)) input.CopyTo(compressed);
   // Verify exact decoded bytes before removing the uncompressed copy.
   using(var original=File.OpenRead(log)) using(var zipped=File.OpenRead(archive))
   using(var decoded=new GZipStream(zipped,CompressionMode.Decompress)) {
    var a=new byte[8192];var b=new byte[8192];int n;
    while((n=original.Read(a,0,a.Length))>0){int got=0,k;while(got<n&&(k=decoded.Read(b,got,n-got))>0)got+=k;if(got!=n)throw new IOException("Archive verification failed.");for(int i=0;i<n;i++)if(a[i]!=b[i])throw new IOException("Archive verification failed.");}
    if(decoded.ReadByte()!=-1)throw new IOException("Archive verification failed.");
   }
   File.WriteAllText(Path.Combine(directory,"log-policy.txt"),Marker);
   File.Delete(log);
   Prune(Path.GetDirectoryName(directory)!,directory,now);
  }
  internal static void Prune(string root,string current,DateTime now) {
   if(!Plain(root)) return;
   var eligible=Directory.EnumerateDirectories(root).Where(dir=>
    Regex.IsMatch(Path.GetFileName(dir),@"^\d{8}-\d{6}-[0-9a-f]{8}$") && !string.Equals(dir,current,StringComparison.OrdinalIgnoreCase) && Plain(dir))
    .Select(dir=>new {Dir=dir,Log=Path.Combine(dir,"install.log.gz"),Stamp=Path.Combine(dir,"log-policy.txt")})
    .Where(x=>File.Exists(x.Log)&&Plain(x.Log)&&File.Exists(x.Stamp)&&Plain(x.Stamp)&&new FileInfo(x.Stamp).Length==Marker.Length&&File.ReadAllText(x.Stamp)==Marker)
    .OrderByDescending(x=>File.GetLastWriteTimeUtc(x.Log)).ToArray();
   for(int i=0;i<eligible.Length;i++) {
    var item=eligible[i];
    if(i>=9 || File.GetLastWriteTimeUtc(item.Log)<now.ToUniversalTime().AddDays(-30)) File.Delete(item.Log);
   }
  }
 }
}