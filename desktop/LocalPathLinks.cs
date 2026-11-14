using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
namespace CodexLight.Desktop;
internal static class LocalPathLinks {
 internal const string ClickScript = """
 (()=>{if(window!==window.top)return;document.addEventListener('click',event=>{
   if(!event.isTrusted||event.button!==0)return;
   const link=event.target instanceof Element?event.target.closest('button.md-file-link[data-path]'):null;
   if(!link)return;const path=link.getAttribute('data-path');if(!path||path.length>4096)return;
   event.preventDefault();event.stopImmediatePropagation();
   window.chrome.webview.postMessage({type:'revealLocalPath',path});
 },true);})();
 """;
 internal static string ReadMessage(string json){
  if(json.Length>8192)throw new InvalidDataException("Message too large.");using var doc=JsonDocument.Parse(json);var value=doc.RootElement;
  if(value.ValueKind!=JsonValueKind.Object||value.EnumerateObject().Count()!=2||!value.TryGetProperty("type",out var type)||type.GetString()!="revealLocalPath"||!value.TryGetProperty("path",out var path)||path.ValueKind!=JsonValueKind.String)throw new InvalidDataException("Invalid local path message.");
  return path.GetString()!;
 }
 internal static bool TrustedSource(string source,Uri? origin){return origin!=null&&Uri.TryCreate(source,UriKind.Absolute,out var url)&&url.Scheme=="http"&&url.Host=="127.0.0.1"&&url.Port==origin.Port&&origin.Scheme==url.Scheme&&origin.Host==url.Host&&url.UserInfo==""&&url.AbsolutePath=="/"&&url.Query=="";}
 internal static string Normalize(string input){
  if(string.IsNullOrWhiteSpace(input)||input.Length>4096||input.Any(c=>char.IsControl(c)))throw new InvalidDataException("Invalid local path.");
  var path=input;
  if(path.StartsWith("file:",StringComparison.OrdinalIgnoreCase)){
   if(!Uri.TryCreate(path,UriKind.Absolute,out var uri)||!uri.IsFile||uri.IsUnc||uri.Host!=""&&uri.Host!="localhost"||uri.UserInfo!=""||uri.Query!=""||uri.Fragment!="")throw new InvalidDataException("Only local file URI allowed.");
   path=uri.LocalPath;
  }
  if(!Regex.IsMatch(path,@"^[A-Za-z]:[\\/]")||path[2..].Contains(':')||path.Any(c=>char.IsControl(c)||"\"<>|?*".Contains(c)))throw new InvalidDataException("Only local drive paths allowed.");
  foreach(var segment in path[3..].Split(new[]{'\\','/'},StringSplitOptions.None)){
   if(segment is "." or ".."||segment.EndsWith('.')||segment.EndsWith(' ')||Regex.IsMatch(segment,@"^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)",RegexOptions.IgnoreCase))throw new InvalidDataException("Unsafe path segment.");
  }
  return Path.GetFullPath(path);
 }
 internal static bool ValidateExisting(string path){
  path=Normalize(path);for(string? part=path;part!=null;part=Path.GetDirectoryName(part))if((File.GetAttributes(part)&FileAttributes.ReparsePoint)!=0)throw new InvalidDataException("Linked paths are not supported.");
  var drive=new DriveInfo(Path.GetPathRoot(path)!);if(drive.DriveType!=DriveType.Fixed&&drive.DriveType!=DriveType.Removable)throw new InvalidDataException("Network or unknown drive refused.");
  if(Directory.Exists(path))return true;if(File.Exists(path))return false;throw new FileNotFoundException("Local path not found.");
 }
 internal static ProcessStartInfo Explorer(string path,bool directory){
  var start=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"explorer.exe")){UseShellExecute=false};start.ArgumentList.Add(directory?path:"/select,"+path);return start;
 }
}
