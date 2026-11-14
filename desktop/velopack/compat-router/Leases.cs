using System;using System.IO;using System.IO.Compression;using System.Linq;using System.Collections.Generic;using System.Security.Cryptography;
namespace CodexLight.PublicSetup {
 internal sealed class VerifiedLease:IDisposable {
  internal readonly FileStream Stream;internal readonly string Path;
  VerifiedLease(string path,FileStream stream){Path=path;Stream=stream;}
  internal static VerifiedLease Open(string path,string expected){Plain(path);var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);try{if(expected.Length!=64||!expected.All(Uri.IsHexDigit))throw new IOException("Invalid expected hash");using(var sha=SHA256.Create())if(!Hex(sha.ComputeHash(stream)).Equals(expected,StringComparison.OrdinalIgnoreCase))throw new IOException("File changed before execution; stopped");stream.Position=0;return new VerifiedLease(path,stream);}catch{stream.Dispose();throw;}}
  internal static string Hex(byte[] hash)=>BitConverter.ToString(hash).Replace("-","").ToLowerInvariant();
  internal static void Plain(string path){for(string? p=System.IO.Path.GetFullPath(path);p!=null;p=System.IO.Path.GetDirectoryName(p))if((File.Exists(p)||Directory.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("Linked path refused");}
  public void Dispose()=>Stream.Dispose();
 }
 internal sealed class FreshLease:IDisposable {
  readonly List<VerifiedLease> files=new List<VerifiedLease>();internal string Installer="";
  internal static FreshLease Extract(VerifiedLease zip,string root){var result=new FreshLease();try{VerifiedLease.Plain(root);if(Directory.Exists(root)||File.Exists(root))throw new IOException("Fresh output already exists");Directory.CreateDirectory(root);zip.Stream.Position=0;using(var archive=new ZipArchive(zip.Stream,ZipArchiveMode.Read,true)){
   if(archive.Entries.Count>20000)throw new IOException("Too many ZIP entries");long total=0;var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   foreach(var e in archive.Entries){RouterPolicy.Member(e.FullName);if(!seen.Add(e.FullName.TrimEnd('/'))||(e.ExternalAttributes&0x400)!=0||((e.ExternalAttributes>>16)&0xF000)==0xA000)throw new IOException("Duplicate or linked ZIP member");total=checked(total+e.Length);if(e.Length>300L*1024*1024||total>1024L*1024*1024)throw new IOException("ZIP too large");}
   foreach(var e in archive.Entries){if(e.FullName.EndsWith("/"))continue;string target=System.IO.Path.GetFullPath(System.IO.Path.Combine(root,e.FullName));if(!target.StartsWith(root+System.IO.Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new IOException("ZIP path escapes root");VerifiedLease.Plain(target);Directory.CreateDirectory(System.IO.Path.GetDirectoryName(target)!);
    // Close the writer before acquiring a read-only execution lease: a held
    // writable handle can prevent Windows/.NET from loading the executable.
    // Rehash against the still-locked ZIP member after opening the read lease,
    // so any replacement in that handoff is detected before execution.
    string expected;using(var source=e.Open())using(var sha=SHA256.Create())expected=VerifiedLease.Hex(sha.ComputeHash(source));
    using(var file=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None)){using(var source=e.Open())source.CopyTo(file);file.Flush(true);if(file.Length!=e.Length)throw new IOException("Incomplete extraction");}
    result.files.Add(VerifiedLease.Open(target,expected));
   }
  }result.Installer=System.IO.Path.Combine(root,"CodexLight-Install.exe");if(!File.Exists(result.Installer))throw new IOException("Missing installer");return result;}catch{result.Dispose();throw;}}
  public void Dispose(){foreach(var file in files)file.Dispose();files.Clear();}
 }
}
