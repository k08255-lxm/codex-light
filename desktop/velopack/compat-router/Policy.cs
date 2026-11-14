using System;
using System.IO;
using System.Linq;
namespace CodexLight.PublicSetup {
 internal static class RouterPolicy {
  internal const string BridgeVersion="0.4.4";
  internal const string BridgeUrl="https://github.com/k08255-lxm/codex-light/releases/download/v0.4.4/CodexLight-Setup-0.4.4-x64.exe";
  internal const string BridgeHash="b2410266d12946301ffecebaa9c1fa77c8cebd065fe889cdb8eb83b974245aba";
  internal static void Redirect(Uri uri){if(uri.Scheme!="https"||!uri.IsDefaultPort||uri.UserInfo!=""||uri.Fragment!=""||!new[]{"github.com","release-assets.githubusercontent.com","objects.githubusercontent.com"}.Contains(uri.Host,StringComparer.OrdinalIgnoreCase))throw new IOException("Unapproved download redirect");}
  internal static void Member(string name){var n=name.TrimEnd('/');if(n.Length==0||name.StartsWith("/")||name.Contains("\\")||name.Contains(":"))throw new IOException("Unsafe ZIP member");foreach(var part in n.Split('/'))if(part.Length==0||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" ")||part.Any(c=>c<32||"<>\"|?*".Contains(c))||System.Text.RegularExpressions.Regex.IsMatch(part.Split('.')[0],"^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$",System.Text.RegularExpressions.RegexOptions.IgnoreCase))throw new IOException("Unsafe ZIP component");}
 }
}
