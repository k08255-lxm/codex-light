using System.IO.Compression;
using System.Security.Cryptography;
namespace CodexLight.Desktop;
internal static class BootstrapPolicy {
 internal static void CheckTarget(string root,string local,string version,string hash,string expectedVersion,string expectedHash){
  if(!string.Equals(WorkerPolicy.Canonical(root),WorkerPolicy.Canonical(Path.Combine(local,"CodexLightDesktop")),StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Repair only supports the existing per-user installation.");
  if(!System.Text.RegularExpressions.Regex.IsMatch(expectedVersion,@"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")||!System.Text.RegularExpressions.Regex.IsMatch(expectedHash,@"^[a-f0-9]{64}$")||version!=expectedVersion||hash!=expectedHash)throw new InvalidDataException("Repair bundle target mismatch or build pins missing.");
 }
 internal static void VerifyApplied(ValidatedVelopackPackage package,Action<int,int>? report=null){
  var installed=VelopackPackage.ReadInstalled(package.Installed.CurrentDirectory,Path.GetDirectoryName(package.Installed.DataRoot));
  if(installed.ProgramRoot!=package.Installed.ProgramRoot||installed.Version!=package.Version)throw new InvalidDataException("Updated version was not installed at the expected location.");
  using var input=File.OpenRead(package.Path);using var zip=new ZipArchive(input,ZipArchiveMode.Read);
  var files=zip.Entries.Where(e=>e.FullName.StartsWith("lib/app/",StringComparison.Ordinal)&&!e.FullName.EndsWith('/')).ToArray();
  int verified=0,lastPercent=0;
  report?.Invoke(0,files.Length);
  foreach(var entry in files){
   var relative=entry.FullName[8..];
   // Velopack relocates its two generated root-level executables during apply.
   // Verify their actual installed bytes, never skip them or exempt suffixes in
   // arbitrary nested directories.
   var destination=installed.CurrentDirectory;
   if(relative=="Squirrel.exe"){destination=installed.ProgramRoot;relative="Update.exe";}
   else if(!relative.Contains('/')&&relative.EndsWith("_ExecutionStub.exe",StringComparison.Ordinal)){
    destination=installed.ProgramRoot;relative=relative[..^"_ExecutionStub.exe".Length]+".exe";
   }
   var target=Path.GetFullPath(Path.Combine(destination,relative.Replace('/',Path.DirectorySeparatorChar)));
   if(!WorkerPolicy.Within(target,destination))throw new InvalidDataException("Payload escapes installed directory.");WorkerPolicy.Plain(target);
   using var actual=File.OpenRead(target);using var expected=entry.Open();
   if(actual.Length!=entry.Length||!CryptographicOperations.FixedTimeEquals(SHA256.HashData(actual),SHA256.HashData(expected)))throw new InvalidDataException("Installed payload does not match verified package: "+entry.FullName);
   int percent=(int)(++verified*100L/files.Length);
   if(percent!=lastPercent){report?.Invoke(verified,files.Length);lastPercent=percent;}
  }
 }
}
