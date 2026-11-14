using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
namespace CodexLight.Migration;
public sealed record DataFile(string Path,long Bytes,string Sha256);
public sealed record DataSnapshot(int Schema,string SourceRoot,string[] Directories,DataFile[] Files,string[] Excluded);
public static class MigrationStorage {
 static readonly string[] DataNames={"state","statistics","dsh","attachments","window-state.json","WebView","recovery"};
 static readonly string[] CacheNames={"logs","Updates","SetupLogs"};
 public static string Canonical(string value){if(!Path.IsPathFullyQualified(value))throw new IOException("Absolute path required.");var full=Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);if(full.Length<4||full.StartsWith(@"\\"))throw new IOException("Local non-root path required.");for(string? p=full;p!=null;p=Path.GetDirectoryName(p)){if(Path.GetFileName(p).Equals(".codex",StringComparison.OrdinalIgnoreCase))throw new IOException("Codex configuration is outside migration scope.");if((File.Exists(p)||Directory.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("Reparse path refused.");}return full;}
 static bool Inside(string root,string candidate)=>candidate.Equals(root,StringComparison.OrdinalIgnoreCase)||candidate.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
 public static void AtomicReceipt<T>(string path,T receipt,Action? beforeCommit=null) {
  path=Canonical(path);var parent=Path.GetDirectoryName(path)!;if(!Directory.Exists(parent))throw new IOException("Receipt parent must already exist.");
  string temporary=Path.Combine(parent,".receipt-"+Guid.NewGuid().ToString("N")+".tmp");
  try{using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)){JsonSerializer.Serialize(stream,receipt);stream.Flush(true);}beforeCommit?.Invoke();Canonical(path);if(File.Exists(path))File.Replace(temporary,path,null);else File.Move(temporary,path);}
  finally{if(File.Exists(temporary))File.Delete(temporary);}
 }
 public static DataSnapshot CaptureApplicationData()=>Capture(Canonical(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLight")));
 internal static DataSnapshot Capture(string root) {
  root=Canonical(root);if(!Directory.Exists(root))throw new IOException("Data root missing.");
  var files=new List<DataFile>();var directories=new List<string>();var excluded=new List<string>();
  void Visit(string path){path=Canonical(path);if(!Inside(root,path))throw new IOException("Traversal escaped data root.");string relative=Path.GetRelativePath(root,path).Replace('\\','/');if(Directory.Exists(path)){directories.Add(relative);foreach(var item in Directory.EnumerateFileSystemEntries(path).OrderBy(x=>x,StringComparer.OrdinalIgnoreCase))Visit(item);}else{var info=new FileInfo(path);if(files.Count>=100000)throw new IOException("Snapshot file-count limit exceeded.");long length=info.Length;long stamp=info.LastWriteTimeUtc.Ticks;string hash=MigrationCoordinator.Hash(path);info.Refresh();if(info.Length!=length||info.LastWriteTimeUtc.Ticks!=stamp)throw new IOException("Data changed while hashing.");files.Add(new(relative,length,hash));}}
  foreach(var entry in Directory.EnumerateFileSystemEntries(root).OrderBy(x=>x,StringComparer.OrdinalIgnoreCase)){Canonical(entry);var name=Path.GetFileName(entry);if(CacheNames.Contains(name,StringComparer.OrdinalIgnoreCase)){excluded.Add(name);continue;}if(!DataNames.Contains(name,StringComparer.OrdinalIgnoreCase))throw new IOException("Unknown app-data entry: "+name);Visit(entry);}
  return new(1,root,directories.ToArray(),files.ToArray(),excluded.ToArray());
 }
 static string SafeMember(string root,string relative){if(string.IsNullOrWhiteSpace(relative)||relative.Contains('\\')||relative.Contains(':')||relative.Split('/').Any(x=>x is "" or "." or ".."||x.EndsWith(' ')||x.EndsWith('.')))throw new IOException("Invalid snapshot member.");var p=Canonical(Path.Combine(root,relative.Replace('/',Path.DirectorySeparatorChar)));if(!Inside(root,p))throw new IOException("Snapshot member escaped root.");return p;}
 static void ValidateManifest(DataSnapshot manifest){if(manifest.Schema!=1||manifest.Files.Length>100000)throw new IOException("Snapshot schema/size invalid.");var source=Canonical(manifest.SourceRoot);foreach(var member in manifest.Directories.Concat(manifest.Files.Select(f=>f.Path))){SafeMember(source,member);if(!DataNames.Contains(member.Split('/' )[0],StringComparer.OrdinalIgnoreCase))throw new IOException("Snapshot includes unknown app-data scope.");}var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);foreach(var d in manifest.Directories)if(!seen.Add(d))throw new IOException("Duplicate snapshot member.");foreach(var f in manifest.Files)if(!seen.Add(f.Path)||f.Bytes<0||f.Sha256.Length!=64||!f.Sha256.All(Uri.IsHexDigit))throw new IOException("Invalid snapshot file.");}
 public static void CopySnapshot(DataSnapshot manifest,string destination) {
  ValidateManifest(manifest);var source=Canonical(manifest.SourceRoot);var target=Canonical(destination);if(Inside(source,target)||Inside(target,source)||Directory.Exists(target)||File.Exists(target))throw new IOException("Snapshot must use a fresh independent recovery directory.");
  // Verify captured source once before copying and again after copying to reject concurrent writers.
  if(JsonSerializer.Serialize(Capture(source))!=JsonSerializer.Serialize(manifest))throw new IOException("Data changed before snapshot.");
  Directory.CreateDirectory(target);
  foreach(var dir in manifest.Directories)Directory.CreateDirectory(SafeMember(target,dir));
  foreach(var f in manifest.Files){var from=SafeMember(source,f.Path);var to=SafeMember(target,f.Path);Directory.CreateDirectory(Path.GetDirectoryName(to)!);File.Copy(from,to,false);}
  VerifySnapshot(manifest,target);
  if(JsonSerializer.Serialize(Capture(source))!=JsonSerializer.Serialize(manifest))throw new IOException("Data changed during snapshot; recovery copy not approved.");
  // Keep metadata separate from content so verification can reject every unknown member.
  AtomicReceipt(target+".manifest.json",manifest);
 }
 public static void VerifySnapshot(DataSnapshot manifest,string root) {
  ValidateManifest(manifest);root=Canonical(root);var expected=new HashSet<string>(manifest.Directories.Concat(manifest.Files.Select(f=>f.Path)),StringComparer.OrdinalIgnoreCase);
  void Walk(string dir){foreach(var p in Directory.EnumerateFileSystemEntries(dir)){Canonical(p);var rel=Path.GetRelativePath(root,p).Replace('\\','/');if(!expected.Remove(rel))throw new IOException("Unknown or duplicate recovery entry.");if(Directory.Exists(p))Walk(p);}}
  Walk(root);if(expected.Count!=0)throw new IOException("Recovery entries missing.");
  foreach(var file in manifest.Files){var p=SafeMember(root,file.Path);if(!File.Exists(p)||new FileInfo(p).Length!=file.Bytes||MigrationCoordinator.Hash(p)!=file.Sha256.ToLowerInvariant())throw new IOException("Recovery byte verification failed.");}
 }
 public static void RestoreToFreshDirectory(DataSnapshot manifest,string snapshotRoot,string destination) {
  var source=Canonical(snapshotRoot);var target=Canonical(destination);var original=Canonical(manifest.SourceRoot);
  if(Inside(original,target)||Inside(target,original)||Inside(source,target)||Inside(target,source)||Directory.Exists(target)||File.Exists(target))throw new IOException("In-place/overwriting restore forbidden.");
  VerifySnapshot(manifest,source);Directory.CreateDirectory(target);
  foreach(var d in manifest.Directories)Directory.CreateDirectory(SafeMember(target,d));
  foreach(var f in manifest.Files){var to=SafeMember(target,f.Path);Directory.CreateDirectory(Path.GetDirectoryName(to)!);File.Copy(SafeMember(source,f.Path),to,false);}VerifySnapshot(manifest,target);
 }
 public static long RequiredBytes(DataSnapshot data,long targetExpanded,long targetPackage,long rollbackMsi,long headroom=64L*1024*1024){if(new[]{targetExpanded,targetPackage,rollbackMsi,headroom}.Any(n=>n<0))throw new ArgumentOutOfRangeException();ValidateManifest(data);checked{long bytes=0;foreach(var f in data.Files)bytes+=f.Bytes;return bytes+targetExpanded*2+targetPackage+rollbackMsi+headroom;}}
 // Acquire and dispose on the same thread. Locks cooperate with the existing app; they do not prove task idleness.
 public static IDisposable AcquireInstallRoots(string oldRoot,string newRoot)=>AcquireInstallRoots(oldRoot,newRoot,WindowsIdentity.GetCurrent().User?.Value??throw new IOException("SID unavailable."));
 internal static IDisposable AcquireInstallRoots(string oldRoot,string newRoot,string sid) {
  var roots=new[]{Canonical(oldRoot),Canonical(newRoot),Canonical(Path.Combine(newRoot,"current"))}.Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(x=>x,StringComparer.OrdinalIgnoreCase).ToArray();var held=new List<Mutex>();
  try{foreach(var root in roots){var normalized=root.ToUpperInvariant();var name=@"Local\CodexLight.Install."+Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid+"\n"+normalized)));var mutex=new Mutex(false,name);bool acquired;try{acquired=mutex.WaitOne(0);}catch(AbandonedMutexException){acquired=true;}if(!acquired){mutex.Dispose();throw new IOException("Application/update holds an install-root lock.");}held.Add(mutex);}return new Lease(held);}
  catch{foreach(var m in held.AsEnumerable().Reverse()){m.ReleaseMutex();m.Dispose();}throw;}
 }
 sealed class Lease(List<Mutex> held):IDisposable {bool disposed;public void Dispose(){if(disposed)return;disposed=true;foreach(var m in held.AsEnumerable().Reverse()){m.ReleaseMutex();m.Dispose();}}}
}
