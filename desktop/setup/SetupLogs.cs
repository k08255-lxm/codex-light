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
  // This class only compresses the current log; historical cleanup is separately source-verified.
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
   // Historical caches are handled by source-verified, recoverable SetupCacheCleanup.
  }
 }
}
