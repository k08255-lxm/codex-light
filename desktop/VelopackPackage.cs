using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
namespace CodexLight.Desktop;
internal sealed record VelopackInstalledIdentity(string ProgramRoot,string CurrentDirectory,string UpdaterPath,string Version,string DataRoot);
// Keeps the verified package open against replacement/write until the caller releases it.
// This is validation evidence, not authorization to stop tasks or apply an update.
internal sealed class ValidatedVelopackPackage : IDisposable {
 readonly FileStream lease;
 internal string Path {get;} internal string Sha256 {get;} internal string Version {get;}
 internal VelopackInstalledIdentity Installed {get;}
 internal ValidatedVelopackPackage(FileStream stream,string path,string hash,string version,VelopackInstalledIdentity installed){lease=stream;Path=path;Sha256=hash;Version=version;Installed=installed;}
 public void Dispose()=>lease.Dispose();
}
internal static class VelopackPackage {
 internal const string PackageId="CodexLightDesktop";
 const long MaxPackage=300L*1024*1024,MaxExpanded=1024L*1024*1024,MaxEntry=128L*1024*1024;
 static readonly Regex VersionPattern=new(@"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$",RegexOptions.CultureInvariant);
 static string Canonical(string value){if(string.IsNullOrWhiteSpace(value)||!Regex.IsMatch(value,@"^[A-Za-z]:[\\/]")||value.Contains('\0'))throw new InvalidDataException("Local absolute path required.");return System.IO.Path.GetFullPath(value).TrimEnd('\\','/');}
 static bool Same(string a,string b)=>string.Equals(Canonical(a),Canonical(b),StringComparison.OrdinalIgnoreCase);
 static bool Within(string child,string parent)=>Same(child,parent)||Canonical(child).StartsWith(Canonical(parent)+System.IO.Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
 static void Plain(string path){for(string? p=Canonical(path);p!=null;p=System.IO.Path.GetDirectoryName(p)){if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new InvalidDataException("Reparse paths refused.");}}
 static Version ParseVersion(string text){if(!VersionPattern.IsMatch(text)||!Version.TryParse(text,out var v))throw new InvalidDataException("Three-part version required.");return v;}
 static string Metadata(Stream stream,bool installed){
  using var reader=XmlReader.Create(stream,new XmlReaderSettings{DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=65536,CloseInput=false});
  var xml=XDocument.Load(reader);XNamespace ns="http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd";
  if(xml.Root?.Name!=ns+"package"||xml.Root.Elements(ns+"metadata").Count()!=1)throw new InvalidDataException("Invalid package metadata.");
  var metadata=xml.Root.Element(ns+"metadata")!;
  string One(string key){var values=metadata.Elements(ns+key).ToArray();if(values.Length!=1||values[0].HasElements)throw new InvalidDataException("Missing or duplicate metadata field.");return values[0].Value;}
  if(One("id")!=PackageId||One("mainExe")!="CodexLight.exe"||One("os")!="win"||One("channel")!="win")throw new InvalidDataException("Package identity mismatch.");
  var rid=One("rid");if(rid!="win-x64"&&!(installed&&rid=="win"))throw new InvalidDataException("Package architecture mismatch.");
  var version=One("version");ParseVersion(version);return version;
 }
 internal static VelopackInstalledIdentity ReadInstalled(string currentDirectory,string? localAppData=null){
  var current=Canonical(currentDirectory);if(!string.Equals(System.IO.Path.GetFileName(current),"current",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Not a Velopack current directory.");
  var root=System.IO.Path.GetDirectoryName(current)??throw new InvalidDataException("Missing program root.");
  var data=Canonical(System.IO.Path.Combine(localAppData??Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLight"));
  if(Within(root,data)||Within(data,root))throw new InvalidDataException("Program root overlaps user data.");
  Plain(current);var updater=System.IO.Path.Combine(root,"Update.exe");var main=System.IO.Path.Combine(current,"CodexLight.exe");var manifest=System.IO.Path.Combine(current,"sq.version");
  foreach(var file in new[]{updater,main,manifest}){Plain(file);if(!File.Exists(file))throw new InvalidDataException("Missing installed file.");}
  using var input=File.OpenRead(manifest);if(input.Length>65536)throw new InvalidDataException("Metadata too large.");
  return new(root,current,updater,Metadata(input,true),data);
 }
 internal static ValidatedVelopackPackage Validate(string file,string sha256,VelopackInstalledIdentity installed){
  if(sha256 is null||!Regex.IsMatch(sha256,@"^[a-f0-9]{64}$"))throw new InvalidDataException("Invalid SHA256.");
  // Re-read rather than trusting an old or caller-constructed identity record.
  var fresh=ReadInstalled(installed.CurrentDirectory,System.IO.Path.GetDirectoryName(installed.DataRoot));
  if(fresh!=installed)throw new InvalidDataException("Installed identity changed.");
  var target=Canonical(file);var dir=System.IO.Path.GetDirectoryName(target)!;var cache=System.IO.Path.Combine(installed.DataRoot,"Updates");
  if(!Same(System.IO.Path.GetDirectoryName(dir)!,cache))throw new InvalidDataException("Package outside updater cache.");
  var match=Regex.Match(System.IO.Path.GetFileName(dir),@"^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([a-f0-9]{16})$");
  if(!match.Success||match.Groups[2].Value!=sha256[..16])throw new InvalidDataException("Cache identity mismatch.");
  var version=match.Groups[1].Value;if(ParseVersion(version)<=ParseVersion(installed.Version)||System.IO.Path.GetFileName(target)!=$"{PackageId}-{version}-full.nupkg")throw new InvalidDataException("Package must be a newer full update.");
  Plain(target);var stream=File.Open(target,FileMode.Open,FileAccess.Read,FileShare.Read);
  try{
   if(stream.Length<1||stream.Length>MaxPackage)throw new InvalidDataException("Package size invalid.");
   if(Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant()!=sha256)throw new InvalidDataException("Package hash mismatch.");stream.Position=0;
   using(var zip=new ZipArchive(stream,ZipArchiveMode.Read,true)){
    if(zip.Entries.Count==0||zip.Entries.Count>20000)throw new InvalidDataException("Entry limit exceeded.");
    long total=0;var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var filePaths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach(var entry in zip.Entries){
     var name=entry.FullName;var normalized=name.TrimEnd('/');
     if(string.IsNullOrEmpty(normalized)||name.Contains('\\')||name.StartsWith('/')||name.Contains(':')||name.Contains('\0'))throw new InvalidDataException("Unsafe archive path.");
     foreach(var part in normalized.Split('/'))if(part.Length==0||part is "." or ".."||part.EndsWith(' ')||part.EndsWith('.')||part.Any(c=>c<32||"<>\"|?*".Contains(c))||Regex.IsMatch(part.Split('.')[0],@"^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$",RegexOptions.IgnoreCase))throw new InvalidDataException("Unsafe archive component.");
     if(!paths.Add(normalized)||(entry.ExternalAttributes&0x400)!=0||((entry.ExternalAttributes>>16)&0xF000)==0xA000)throw new InvalidDataException("Duplicate or linked archive entry.");
     if(entry.Length<0||entry.Length>MaxEntry||(total+=entry.Length)>MaxExpanded)throw new InvalidDataException("Expanded package too large.");
     if(!name.EndsWith('/'))filePaths.Add(normalized);
    }
    foreach(var name in paths){var parts=name.Split('/');for(int i=1;i<parts.Length;i++)if(filePaths.Contains(string.Join('/',parts.Take(i))))throw new InvalidDataException("File/directory collision.");}
    var spec=zip.GetEntry(PackageId+".nuspec")??throw new InvalidDataException("Package metadata missing.");
    using(var metadata=spec.Open())if(Metadata(metadata,false)!=version)throw new InvalidDataException("Package version mismatch.");
    var sq=zip.GetEntry("lib/app/sq.version")??throw new InvalidDataException("Installed metadata missing.");
    using(var metadata=sq.Open())if(Metadata(metadata,true)!=version)throw new InvalidDataException("Installed package version mismatch.");
    foreach(var required in new[]{"lib/app/CodexLight.exe","lib/app/CodexLight.dll","lib/app/app/src/desktop-backend.mjs"})if(!filePaths.Contains(required))throw new InvalidDataException("Incomplete application payload.");
   }
   stream.Position=0;return new(stream,target,sha256,version,installed);
  }catch{stream.Dispose();throw;}
 }
}
