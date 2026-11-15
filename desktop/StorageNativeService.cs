using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.IO.Compression;
using Microsoft.Win32.SafeHandles;
namespace CodexLight.Desktop;

// All leaf operations use the checked handle. No pathname deletion or overwrite fallback.
internal sealed class StoragePinnedFile : IDisposable {
 const uint Read=0x80000000,Write=0x40000000,Delete=0x10000,ReadAttributes=0x80;
 const uint ShareRead=1,OpenExisting=3,CreateNew=1,Reparse=0x00200000,Backup=0x02000000;
 readonly List<SafeFileHandle> parents=[];
 SafeFileHandle? handle; readonly string filePath; public FileStream Stream {get;private set;}=null!;
 [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,WriteTime; public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr sec,uint create,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int cls,ref byte data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int cls,IntPtr data,uint size);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct RenameInfo {public uint Flags;public IntPtr RootDirectory;public uint FileNameLength;public char FileName;}
 static Info Inspect(SafeFileHandle h,bool directory){if(!GetFileInformationByHandle(h,out var i))throw new Win32Exception(Marshal.GetLastWin32Error());if((i.Attributes&0x400)!=0||((i.Attributes&0x10)!=0)!=directory)throw new IOException("Reparse point or wrong type");return i;}
 static SafeFileHandle Open(string p,uint access,uint creation=OpenExisting){var h=CreateFile(@"\\?\"+p,access,ShareRead,IntPtr.Zero,creation,Reparse|Backup,IntPtr.Zero);if(h.IsInvalid){int error=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(error);}return h;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern uint GetDriveTypeW(string root);
 public static string Resolve(string root,string relative){root=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);if(root.StartsWith("\\\\")||root.Length<3||GetDriveTypeW(Path.GetPathRoot(root)??"")!=3||string.IsNullOrEmpty(relative)||Path.IsPathRooted(relative)||relative.Contains(':'))throw new IOException("Local relative path required");foreach(var c in relative.Split(['\\','/']))if(c is ".." or "." or ""||c.EndsWith('.')||c.EndsWith(' '))throw new IOException("Noncanonical path");string file=Path.GetFullPath(Path.Combine(root,relative));if(!file.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new IOException("Outside root");return file;}
 public StoragePinnedFile(string root,string relative,bool create=false,bool writable=false,bool readOnly=false){try{string file=Resolve(root,relative);filePath=file;var dirs=new Stack<string>();for(string? d=Path.GetDirectoryName(file);d!=null;d=Path.GetDirectoryName(d))dirs.Push(d);while(dirs.Count>0){string d=dirs.Pop();if(create&&!Directory.Exists(d))Directory.CreateDirectory(d);var h=Open(d,ReadAttributes);parents.Add(h);Inspect(h,true);}handle=Open(file,Read|(readOnly?0:Delete)|(create||writable?Write:0),create?CreateNew:OpenExisting);var info=Inspect(handle,false);if(info.Links!=1)throw new IOException("Hard-linked files are excluded");Stream=new FileStream(handle,create||writable?FileAccess.ReadWrite:FileAccess.Read);}catch{Dispose();throw;}}
 public string Snapshot(){var i=Inspect(handle!,false);Stream.Position=0;string digest=Convert.ToHexString(SHA256.HashData(Stream)).ToLowerInvariant();return string.Join(":",i.Volume,i.IndexHigh,i.IndexLow,i.SizeHigh,i.SizeLow,i.WriteTime.dwHighDateTime,i.WriteTime.dwLowDateTime,digest);}
 public string Digest(){Stream.Position=0;return Convert.ToHexString(SHA256.HashData(Stream)).ToLowerInvariant();}
 public long Length=>Stream.Length;
 public DateTime LastWriteUtc {get{var i=Inspect(handle!,false);return DateTime.FromFileTimeUtc(((long)i.WriteTime.dwHighDateTime<<32)|(uint)i.WriteTime.dwLowDateTime);}}
 public void DeleteVerified(string snapshot){if(Snapshot()!=snapshot)throw new IOException("File differs from approved snapshot");byte yes=1;if(!SetFileInformationByHandle(handle!,4,ref yes,1))throw new Win32Exception(Marshal.GetLastWin32Error());}
 public void CommitSameParent(string root,string relative){string target=Resolve(root,relative);if(!string.Equals(Path.GetDirectoryName(target),Path.GetDirectoryName(filePath),StringComparison.OrdinalIgnoreCase))throw new IOException("Rename must stay in pinned parent");byte[] name=System.Text.Encoding.Unicode.GetBytes(@"\\?\"+target);int offset=(int)Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.FileName));int size=checked(offset+name.Length+2);IntPtr buffer=Marshal.AllocHGlobal(size);try{for(int n=0;n<size;n++)Marshal.WriteByte(buffer,n,0);Marshal.WriteInt32(buffer,(int)Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.FileNameLength)),name.Length);Marshal.Copy(name,0,IntPtr.Add(buffer,offset),name.Length);if(!SetFileInformationByHandle(handle!,3,buffer,(uint)size))throw new Win32Exception(Marshal.GetLastWin32Error());}finally{Marshal.FreeHGlobal(buffer);}}
 public void Dispose(){Stream?.Dispose();handle?.Dispose();for(int n=parents.Count-1;n>=0;n--)parents[n].Dispose();parents.Clear();}
}

internal sealed class StorageNativeService {
 const long MaxFile=32L*1024*1024,MaxTotal=128L*1024*1024;
 const int MaxFiles=256;
 readonly string root,activeProfile;readonly Func<IDisposable> acquireMaintenance;
 readonly Dictionary<string,Plan> plans=[];
 record Entry(string Relative,string Snapshot,string Sha256,long Size);
 record Plan(string Category,string Mode,List<Entry> Files,string Digest,DateTime Expires);
 record ArchiveEntry(string Relative,string Archive,string Sha256,long Size);
 record ArchiveManifest(int Version,string Root,string Category,List<ArchiveEntry> Files);
 static readonly JsonSerializerOptions Json=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase,PropertyNameCaseInsensitive=true};
 // Values come from native host state, never renderer/HTTP input.
 public StorageNativeService(string root,string activeProfile,Func<IDisposable> acquireMaintenance){this.root=Path.GetFullPath(root);this.activeProfile=Path.GetFullPath(activeProfile);this.acquireMaintenance=acquireMaintenance;}
 public object Execute(string action,JsonElement input){using var maintenance=acquireMaintenance();return action switch{"snapshot"=>Snapshot(input),"apply"=>Apply(input),"restore"=>Restore(input),"inspectInstallSources"=>InspectInstallSources(input),_=>throw new IOException("Unknown storage action")};}
 static string Text(JsonElement e,string key)=>e.GetProperty(key).GetString()??throw new IOException("Missing field");
 static void Exact(JsonElement e,params string[] fields){if(e.ValueKind!=JsonValueKind.Object||e.EnumerateObject().Count()!=fields.Length||fields.Any(f=>!e.TryGetProperty(f,out _)))throw new IOException("Unexpected storage input");}
 string Normalize(string relative)=>Path.GetRelativePath(root,StoragePinnedFile.Resolve(root,relative)).Replace('\\','/');
 bool Allowed(string category,string relative,string mode="archive"){
  string r=Normalize(relative);
  if(category=="cache"){
   var m=Regex.Match(r,@"^WebView/Sessions/([0-9a-f]{32})/(?:[0-9a-f]{32}/EBWebView/)?(?:Default/(?:Cache|Code Cache|GPUCache)|GPUCache)/[^:]+$");
   string active=Path.GetRelativePath(Path.Combine(root,"WebView","Sessions"),activeProfile).Split(Path.DirectorySeparatorChar)[0];
   return m.Success&&Regex.IsMatch(active,"^[0-9a-f]{32}$")&&!m.Groups[1].Value.Equals(active,StringComparison.OrdinalIgnoreCase);
  }
  if(category=="install"&&MsiCleanupEligibility.IsCandidate(r))return mode=="delete";
  if(category=="install"&&Regex.IsMatch(r,@"^SetupLogs/\d{8}-\d{6}-[a-f0-9]{8}/install\.log$"))return mode=="delete"&&OldSetupLog(r);
  if(category=="install")return Regex.IsMatch(r,@"^Updates/\d+\.\d+\.\d+-[a-f0-9]{16}/"+(mode=="delete"?@"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial":@"(?:CodexLight-Setup\.exe|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial)")+"$");
  // Image reference ownership is enforced by Node's image maintenance lease; paths remain narrow here.
  return category=="images"&&Regex.IsMatch(r,@"^images/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp|gif)$");
 }
 bool OldSetupLog(string relative){string baseDir=Path.Combine(root,"SetupLogs");string selected=Normalize(relative).Split('/')[1];var newest=Directory.Exists(baseDir)?Directory.EnumerateDirectories(baseDir).Select(Path.GetFileName).Where(n=>n!=null&&Regex.IsMatch(n,@"^\d{8}-\d{6}-[a-f0-9]{8}$")).OrderByDescending(n=>n,StringComparer.Ordinal).FirstOrDefault():null;return newest!=null&&selected!=newest;}
 IDisposable? PinLatestLog(IEnumerable<string> relatives){if(!relatives.Any(r=>Normalize(r).StartsWith("SetupLogs/",StringComparison.Ordinal)&&Normalize(r).EndsWith("/install.log",StringComparison.Ordinal)))return null;string dir=Path.Combine(root,"SetupLogs");string? latest=Directory.EnumerateDirectories(dir).Select(Path.GetFileName).Where(n=>n!=null&&Regex.IsMatch(n,@"^\d{8}-\d{6}-[a-f0-9]{8}$")).OrderByDescending(n=>n,StringComparer.Ordinal).FirstOrDefault();if(latest==null||relatives.Any(r=>Normalize(r).StartsWith("SetupLogs/"+latest+"/",StringComparison.Ordinal)&&Normalize(r).EndsWith("/install.log",StringComparison.Ordinal)))throw new IOException("Latest installation log is protected");return new StoragePinnedFile(root,"SetupLogs/"+latest+"/install.log");}
 object InspectInstallSources(JsonElement input){Exact(input,"relatives");var paths=input.GetProperty("relatives").EnumerateArray().Select(x=>Normalize(x.GetString()??"")).ToArray();if(paths.Length>MaxFiles)throw new IOException("Too many MSI candidates");return new{files=paths.Select(relative=>{var result=MsiCleanupEligibility.Check(root,relative);return new{relative,eligible=result.Eligible,reason=result.Reason,scope="codecang-family-current-user-and-machine",requiresElevation=result.RequiresElevation};}).ToArray()};}
 readonly Dictionary<string,MsiPackageIdentity> msiIdentities=new(StringComparer.OrdinalIgnoreCase);
 string? RequireMsi(string relative){if(!MsiCleanupEligibility.IsCandidate(relative))return null;var decision=MsiCleanupEligibility.Check(root,relative);if(!decision.Eligible||decision.Snapshot==null)throw new IOException(decision.Reason);if(decision.Identity==null)throw new IOException("Missing MSI identity");msiIdentities[relative]=decision.Identity;return decision.Snapshot;}
 object Snapshot(JsonElement input){Exact(input,"category","mode","relatives");string category=Text(input,"category"),mode=Text(input,"mode");if(mode!="delete")throw new IOException("Unknown mode");var paths=input.GetProperty("relatives").EnumerateArray().Select(x=>Normalize(x.GetString()??"")).ToArray();if(paths.Length>MaxFiles||paths.Distinct(StringComparer.OrdinalIgnoreCase).Count()!=paths.Length)throw new IOException("Invalid candidate count");using var logWitness=PinLatestLog(paths);var entries=new List<Entry>();long total=0;foreach(string rel in paths){string relative=Normalize(rel);if(!Allowed(category,relative,mode))throw new IOException("Candidate is outside owned category");string? msiSnapshot=RequireMsi(relative);using var file=new StoragePinnedFile(root,relative);if(msiSnapshot!=null&&file.Snapshot()!=msiSnapshot)throw new IOException("MSI identity changed after verification");if(file.Length>MaxFile||total+file.Length>MaxTotal)throw new IOException("Storage limit exceeded");if(category=="install"&&mode=="delete"&&!MsiCleanupEligibility.IsCandidate(relative)&&DateTime.UtcNow-file.LastWriteUtc<(relative.StartsWith("SetupLogs/",StringComparison.Ordinal)?TimeSpan.FromDays(1):TimeSpan.FromDays(7)))throw new IOException("Download is not expired");string snapshot=file.Snapshot();entries.Add(new(relative,snapshot,snapshot.Split(':')[^1],file.Length));total+=file.Length;}
  if(plans.Count>=16)plans.Clear();string id=Guid.NewGuid().ToString("D"),digest=Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(entries,Json))).ToLowerInvariant();var expires=DateTime.UtcNow.AddMinutes(2);plans[id]=new(category,mode,entries,digest,expires);return new{id,manifestDigest=digest,expiresAt=new DateTimeOffset(expires).ToUnixTimeMilliseconds(),fileCount=entries.Count,bytes=total,category,mode};
 }
 object Apply(JsonElement input){if(input.TryGetProperty("confirmedMsiScope",out _))Exact(input,"id","manifestDigest","confirmed","confirmedMsiScope");else Exact(input,"id","manifestDigest","confirmed");string id=Text(input,"id");if(input.GetProperty("confirmed").ValueKind!=JsonValueKind.True||!plans.TryGetValue(id,out var plan)||plan.Digest!=Text(input,"manifestDigest")||plan.Expires<DateTime.UtcNow)throw new IOException("Fresh confirmation required");if(plan.Files.Any(e=>MsiCleanupEligibility.IsCandidate(e.Relative))&&(!input.TryGetProperty("confirmedMsiScope",out var scopeConfirmation)||scopeConfirmation.ValueKind!=JsonValueKind.True))throw new IOException("Explicit current-user and machine MSI permanent-delete confirmation required");plans.Remove(id);using var installerLease=plan.Files.Any(e=>MsiCleanupEligibility.IsCandidate(e.Relative))?MsiCleanupEligibility.AcquireKnownInstallerIdle():null;using var logWitness=PinLatestLog(plan.Files.Select(e=>e.Relative));
  var pinned=new List<StoragePinnedFile>();var outputs=new List<StoragePinnedFile>();long archiveBytes=0,removedBytes=0;int removed=0;string? recoveryId=null;var failures=new List<string>();
  try{
   // Fail the entire batch before mutation if any original no longer matches.
   foreach(var entry in plan.Files){if(!Allowed(plan.Category,entry.Relative,plan.Mode))throw new IOException("Eligibility changed");string? msiSnapshot=RequireMsi(entry.Relative);var file=new StoragePinnedFile(root,entry.Relative);pinned.Add(file);if(msiSnapshot!=null&&file.Snapshot()!=msiSnapshot)throw new IOException("MSI identity changed after verification");if(file.Snapshot()!=entry.Snapshot)throw new IOException("File changed since preview");if(plan.Category=="install"&&plan.Mode=="delete"&&!MsiCleanupEligibility.IsCandidate(entry.Relative)&&DateTime.UtcNow-file.LastWriteUtc<(entry.Relative.StartsWith("SetupLogs/",StringComparison.Ordinal)?TimeSpan.FromDays(1):TimeSpan.FromDays(7)))throw new IOException("Download is active");}
   if(plan.Mode=="archive"){
    recoveryId=Guid.NewGuid().ToString("D");var records=new List<ArchiveEntry>();
    for(int n=0;n<pinned.Count;n++){string name=n+".gz";var dest=new StoragePinnedFile(root,$"StorageRecovery/{recoveryId}/{name}",create:true);outputs.Add(dest);pinned[n].Stream.Position=0;using(var gzip=new GZipStream(dest.Stream,CompressionLevel.Optimal,true))pinned[n].Stream.CopyTo(gzip);dest.Stream.Flush(true);archiveBytes+=dest.Length;dest.Stream.Position=0;using(var gzip=new GZipStream(dest.Stream,CompressionMode.Decompress,true)){string digest=Convert.ToHexString(SHA256.HashData(gzip)).ToLowerInvariant();if(digest!=plan.Files[n].Sha256)throw new IOException("Archive verification failed");}records.Add(new(plan.Files[n].Relative,name,plan.Files[n].Sha256,plan.Files[n].Size));}
    var manifest=new StoragePinnedFile(root,$"StorageRecovery/{recoveryId}/manifest.json",create:true);outputs.Add(manifest);byte[] data=JsonSerializer.SerializeToUtf8Bytes(new ArchiveManifest(1,root,plan.Category,records),Json);manifest.Stream.Write(data);manifest.Stream.Flush(true); // Durable originals' equivalent copies before disposition; outputs stay pinned.
   }
   for(int n=0;n<pinned.Count;n++){try{string relative=plan.Files[n].Relative;if(MsiCleanupEligibility.IsCandidate(relative)){if(!msiIdentities.TryGetValue(relative,out var identity))throw new IOException("Missing MSI identity");var current=MsiCleanupEligibility.Revalidate(root,relative,identity);if(!current.Eligible)throw new IOException(current.Reason);}pinned[n].DeleteVerified(plan.Files[n].Snapshot);removed++;removedBytes+=plan.Files[n].Size;}catch{failures.Add("A changed or busy file was retained.");}}
  }finally{foreach(var file in pinned)file.Dispose();foreach(var file in outputs)file.Dispose();}
  return new{outcome=failures.Count>0?"partial":"succeeded",removedFiles=removed,removedBytes,archiveBytes,recoveryId,estimatedNetBytes=removedBytes-archiveBytes,failures=failures.Distinct().ToArray(),note=plan.Mode=="delete"?"Confirmed files permanently deleted; bytes are logical file sizes.":"Verified recovery archive retained; logical size difference is not measured free space."};
 }
 object Restore(JsonElement input){Exact(input,"recoveryId","confirmed");string id=Text(input,"recoveryId");if(!Guid.TryParseExact(id,"D",out _)||input.GetProperty("confirmed").ValueKind!=JsonValueKind.True)throw new IOException("Restore confirmation required");using var manifest=new StoragePinnedFile(root,$"StorageRecovery/{id}/manifest.json");if(manifest.Length>1024*1024)throw new IOException("Manifest too large");var m=JsonSerializer.Deserialize<ArchiveManifest>(manifest.Stream,Json)??throw new IOException("Invalid manifest");if(m.Version!=1||m.Root!=root||m.Files==null||m.Files.Count>MaxFiles||m.Files.Any(e=>e==null||e.Size<0||e.Size>MaxFile)||m.Files.Sum(e=>e.Size)>MaxTotal)throw new IOException("Invalid or oversized manifest");int restored=0;var failures=new List<string>();foreach(var e in m.Files){try{if(!Allowed(m.Category,e.Relative)||!Regex.IsMatch(e.Archive,@"^\d+\.gz$")||!Regex.IsMatch(e.Sha256,"^[a-f0-9]{64}$")||e.Size<0||e.Size>MaxFile)throw new IOException("Invalid record");using var source=new StoragePinnedFile(root,$"StorageRecovery/{id}/{e.Archive}");if(source.Length>MaxFile+65536)throw new IOException("Archive too large");using var bytes=new MemoryStream();using(var gzip=new GZipStream(source.Stream,CompressionMode.Decompress,true)){byte[] buf=new byte[65536];int count;while((count=gzip.Read(buf))>0){if(bytes.Length+count>e.Size)throw new IOException("Archive exceeds declared size");bytes.Write(buf,0,count);}}if(bytes.Length!=e.Size||Convert.ToHexString(SHA256.HashData(bytes.ToArray())).ToLowerInvariant()!=e.Sha256)throw new IOException("Archive verification failed");string temporary=Path.Combine(Path.GetDirectoryName(e.Relative)??"",$".__codecang-restore-{Guid.NewGuid():N}.tmp");using var dest=new StoragePinnedFile(root,temporary,create:true);try{bytes.Position=0;bytes.CopyTo(dest.Stream);dest.Stream.Flush(true);if(dest.Digest()!=e.Sha256)throw new IOException("Restored hash mismatch");dest.CommitSameParent(root,e.Relative);restored++;}catch{dest.DeleteVerified(dest.Snapshot());throw;}}catch(Exception error){failures.Add("Existing, protected or invalid file not overwritten ("+error.GetType().Name+":"+(error is Win32Exception native?native.NativeErrorCode:error.HResult)+").");}}
  return new{outcome=failures.Count>0?"partial":"succeeded",restoredFiles=restored,failures=failures.Distinct().ToArray(),note="Recovery archive retained."};
 }
}







