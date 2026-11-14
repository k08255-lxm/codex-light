using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
namespace CodexLight.Bootstrap {
 // Lossless, independently restorable archives. Never expire archives automatically.
 internal static class RecoverableArchive {
  internal static string Hash(string file){using(var s=File.OpenRead(file))using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(s)).Replace("-","").ToLowerInvariant();}
  internal static bool Equal(string file,string compressed){using(var a=File.OpenRead(file))using(var f=File.OpenRead(compressed))using(var b=new GZipStream(f,CompressionMode.Decompress)){var x=new byte[8192];var y=new byte[8192];int n;while((n=a.Read(x,0,x.Length))>0){int k=0,r;while(k<n&&(r=b.Read(y,k,n-k))>0)k+=r;if(k!=n)return false;for(int i=0;i<n;i++)if(x[i]!=y[i])return false;}return b.ReadByte()==-1;}}
  internal static string Archive(string directory,string archiveRoot,Action<string>? beforeVerification=null) {
   if(!SetupCacheCleanup.PlainPath(directory)||!SetupCacheCleanup.PlainPath(archiveRoot)||Directory.EnumerateDirectories(directory).Any())throw new IOException("Unsafe archive source.");
   var files=Directory.GetFiles(directory).OrderBy(f=>f,StringComparer.Ordinal).ToArray();
   if(files.Length==0||files.Any(f=>!SetupCacheCleanup.PlainPath(f)||Path.GetFileName(f).IndexOfAny(new[]{'\t','\r','\n'})>=0))throw new IOException("Unsafe archive entries.");
   long sourceBytes=files.Sum(f=>new FileInfo(f).Length);
   var disk=new DriveInfo(Path.GetPathRoot(Path.GetFullPath(archiveRoot))!);
   if(disk.AvailableFreeSpace<sourceBytes+16L*1024*1024)throw new IOException("Insufficient temporary space for a verified recoverable archive.");
   Directory.CreateDirectory(archiveRoot);
   string archive=Path.Combine(archiveRoot,DateTime.UtcNow.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(archive);
   var lines=new System.Collections.Generic.List<string>();
   foreach(var file in files){var name=Path.GetFileName(file);using(var input=File.Open(file,FileMode.Open,FileAccess.Read,FileShare.Read))using(var output=new FileStream(Path.Combine(archive,name+".gz"),FileMode.CreateNew,FileAccess.Write,FileShare.None))using(var zip=new GZipStream(output,CompressionLevel.Optimal))input.CopyTo(zip);lines.Add(Hash(file)+"\t"+new FileInfo(file).Length+"\t"+name);}
   File.WriteAllLines(Path.Combine(archive,"manifest.tsv"),lines,Encoding.UTF8);
   File.WriteAllText(Path.Combine(archive,"Restore.ps1"),RestoreScript,Encoding.UTF8);
   beforeVerification?.Invoke(archive);
   // Complete archive roundtrip must pass before any source is touched.
   foreach(var file in files)if(!Equal(file,Path.Combine(archive,Path.GetFileName(file)+".gz")))throw new IOException("Archive verification failed; original cache retained.");
   File.WriteAllText(Path.Combine(archive,"verified.txt"),"CodexLight lossless cache archive v1\nSource: "+directory+"\nRestore: .\\Restore.ps1 -Destination <new-empty-directory>\nArchives are not automatically deleted.\n",Encoding.UTF8);
   // Revalidate each original against the published archive immediately before removal.
   if(!SetupCacheCleanup.PlainPath(directory)||Directory.EnumerateDirectories(directory).Any()||!Directory.GetFiles(directory).OrderBy(f=>f,StringComparer.Ordinal).SequenceEqual(files))throw new IOException("Source changed; archive retained, originals untouched.");
   foreach(var file in files){if(!SetupCacheCleanup.PlainPath(file)||!Equal(file,Path.Combine(archive,Path.GetFileName(file)+".gz")))throw new IOException("Source changed; remaining originals retained.");File.Delete(file);}
   Directory.Delete(directory,false);
   return archive;
  }
  const string RestoreScript=@"param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$target=[IO.Path]::GetFullPath($Destination)
if(Test-Path -LiteralPath $target){throw 'Destination must not exist; no user file will be overwritten.'}
function Assert-Plain([string]$p){while($p){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reparse paths refused'};$p=[IO.Path]::GetDirectoryName($p)}}
Assert-Plain $PSScriptRoot;Assert-Plain $target
$entries=@(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.tsv') -Encoding UTF8 | ForEach-Object {
 $p=$_ -split [char]9
 if($p.Length -ne 3 -or $p[0] -notmatch '^[a-f0-9]{64}$' -or $p[1] -notmatch '^\d+$' -or $p[2] -ne [IO.Path]::GetFileName($p[2]) -or $p[2] -in @('.','..') -or $p[2].IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0){throw 'Invalid manifest'}
 [pscustomobject]@{Hash=$p[0];Size=[long]$p[1];Name=$p[2]}
})
if(!$entries.Count -or @($entries.Name|Select-Object -Unique).Count -ne $entries.Count){throw 'Empty or duplicate manifest'}
New-Item -ItemType Directory -Path $target | Out-Null
foreach($entry in $entries){
 $source=Join-Path $PSScriptRoot ($entry.Name+'.gz');Assert-Plain $source
 $file=Join-Path $target $entry.Name
 $input=[IO.File]::OpenRead($source);$zip=[IO.Compression.GZipStream]::new($input,[IO.Compression.CompressionMode]::Decompress);$output=[IO.File]::Open($file,[IO.FileMode]::CreateNew)
 try{$zip.CopyTo($output)}finally{$output.Dispose();$zip.Dispose();$input.Dispose()}
 if((Get-Item -LiteralPath $file).Length -ne $entry.Size -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.Hash){throw 'Restore verification failed; archive retained'}
}
Write-Output ('Restored and SHA256-verified: '+$target)
";
 }
}
