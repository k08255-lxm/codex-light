using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Security.Cryptography;
namespace CodexLight.Bootstrap {
 // Pure planning/journal primitives only. No filesystem, process, registry or install actions.
 internal sealed class UpgradeFile {
  public string Path{get;} public long Size{get;} public string Sha256{get;}
  public UpgradeFile(string path,long size,string sha256){Path=path;Size=size;Sha256=sha256;}
 }
 internal sealed class InstallReceipt {
  public string InstallId{get;} public string Target{get;} public IReadOnlyList<UpgradeFile> Files{get;}
  public InstallReceipt(string installId,string target,IEnumerable<UpgradeFile> files){InstallId=installId;Target=target;Files=UpgradePlanner.ValidateFiles(files).AsReadOnly();}
  // Canonical length-prefixed record, not a permissive JSON deserializer.
  public string Fingerprint(){UpgradePlanner.ValidateIdentity(InstallId,Target);var text=new StringBuilder("CodexLightReceipt1\n");Action<string> add=value=>text.Append(value.Length).Append(':').Append(value).Append('\n');add(InstallId);add(Target.ToUpperInvariant());foreach(var file in Files.OrderBy(f=>f.Path,StringComparer.OrdinalIgnoreCase)){add(file.Path.ToUpperInvariant());add(file.Size.ToString(System.Globalization.CultureInfo.InvariantCulture));add(file.Sha256.ToLowerInvariant());}using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text.ToString()))).Replace("-","").ToLowerInvariant();}
 }
 internal sealed class UpgradeStep {
  public string Kind{get;} public string Path{get;} public UpgradeFile? Before{get;} public UpgradeFile? After{get;}
  public UpgradeStep(string kind,string path,UpgradeFile? before,UpgradeFile? after){Kind=kind;Path=path;Before=before;After=after;}
 }
 internal sealed class UpgradePlan {
  public string Target{get;} public string ReceiptHash{get;} public IReadOnlyList<UpgradeStep> Steps{get;} public IReadOnlyList<string> PreservedUnknown{get;}
  public UpgradePlan(string target,string hash,List<UpgradeStep> steps,List<string> unknown){Target=target;ReceiptHash=hash;Steps=steps.AsReadOnly();PreservedUnknown=unknown.AsReadOnly();}
 }
 internal static class UpgradePlanner {
  static readonly StringComparer Names=StringComparer.OrdinalIgnoreCase;
  public static void ValidateIdentity(string id,string target){Guid parsed;if(!Guid.TryParseExact(id,"D",out parsed))throw new InvalidOperationException("Invalid installation id");if(string.IsNullOrEmpty(target)||!System.Text.RegularExpressions.Regex.IsMatch(target,@"^[A-Za-z]:\\[^\\]+")||target.EndsWith("\\")||target.IndexOfAny(new[]{'\0','\r','\n','/'})>=0||target.Split('\\').Skip(1).Any(p=>p=="."||p==".."||p.Length==0))throw new InvalidOperationException("Target must be a canonical Windows absolute directory");}
  public static void ValidatePath(string value,bool managed=true){
   if(string.IsNullOrEmpty(value)||value.Length>2048||value.IndexOfAny(new[]{'\\',':','\0','\r','\n'})>=0)throw new InvalidOperationException("Invalid managed path");
   foreach(string part in value.Split('/')){if(part.Length==0||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" ")||part.Any(c=>c<32||c==127)||part.IndexOfAny(new[]{'*','?','"','<','>','|'})>=0)throw new InvalidOperationException("Unsafe managed path");string stem=part.Split('.')[0].ToUpperInvariant();if(new[]{"CON","PRN","AUX","NUL"}.Contains(stem)||System.Text.RegularExpressions.Regex.IsMatch(stem,@"^(COM|LPT)[0-9¹²³]$"))throw new InvalidOperationException("Device path forbidden");if(managed&&new[]{".codex","settings","auth","project","projects"}.Contains(part.ToLowerInvariant()))throw new InvalidOperationException("User data is never managed by the installer");}
  }
  public static List<UpgradeFile> ValidateFiles(IEnumerable<UpgradeFile> files,bool managed=true){if(files==null)throw new InvalidOperationException("Missing manifest");var list=files.Take(3001).ToList();if(list.Count==0||list.Count>3000)throw new InvalidOperationException("Manifest size invalid");var names=new HashSet<string>(Names);foreach(var file in list){if(file==null)throw new InvalidOperationException("Invalid file");ValidatePath(file.Path,managed);if(!names.Add(file.Path)||file.Size<0||file.Size>1024L*1024*1024||!System.Text.RegularExpressions.Regex.IsMatch(file.Sha256??"",@"\A[0-9a-fA-F]{64}\z"))throw new InvalidOperationException("Invalid manifest entry");}foreach(var file in list){var parts=file.Path.Split('/');for(int n=1;n<parts.Length;n++)if(names.Contains(string.Join("/",parts.Take(n))))throw new InvalidOperationException("File/directory collision");}return list;}
  public static UpgradePlan Create(InstallReceipt receipt,string registeredTarget,string registeredUninstall,string registeredReceiptHash,IEnumerable<UpgradeFile> trustedNewFiles,IEnumerable<UpgradeFile> observedTargetFiles,bool appRunning){
   if(appRunning)throw new InvalidOperationException("Close the app normally before upgrading");if(receipt==null)throw new InvalidOperationException("Unregistered installations require explicit legacy repair");
   string hash=receipt.Fingerprint();if(!Names.Equals(registeredTarget,receipt.Target)||!Names.Equals(registeredUninstall,"\""+receipt.Target+"\\Uninstall.exe\" /uninstall")||!Names.Equals(hash,registeredReceiptHash))throw new InvalidOperationException("Installation registration and receipt do not match");
   var next=ValidateFiles(trustedNewFiles).ToDictionary(f=>f.Path,Names);var observed=ValidateFiles(observedTargetFiles,false).ToDictionary(f=>f.Path,Names);var old=receipt.Files.ToDictionary(f=>f.Path,Names);foreach(var n in next.Keys)foreach(var existing in observed.Keys)if(!Names.Equals(n,existing)&&(n.StartsWith(existing+"/",StringComparison.OrdinalIgnoreCase)||existing.StartsWith(n+"/",StringComparison.OrdinalIgnoreCase)))throw new InvalidOperationException("File/directory collision across old and new trees");var steps=new List<UpgradeStep>();
   foreach(var file in old.Values){if(!observed.TryGetValue(file.Path,out var actual)||actual.Size!=file.Size||!Names.Equals(actual.Sha256,file.Sha256))throw new InvalidOperationException("Modified or missing managed file; repair required");}
   foreach(var file in next.Values){if(old.TryGetValue(file.Path,out var before))steps.Add(new UpgradeStep(Names.Equals(before.Sha256,file.Sha256)&&before.Size==file.Size?"keep":"replace",file.Path,before,file));else{if(observed.ContainsKey(file.Path))throw new InvalidOperationException("New managed file collides with unknown user file");steps.Add(new UpgradeStep("add",file.Path,null,file));}}
   foreach(var file in old.Values)if(!next.ContainsKey(file.Path))steps.Add(new UpgradeStep("retire",file.Path,file,null));
   return new UpgradePlan(receipt.Target,hash,steps,observed.Keys.Where(k=>!old.ContainsKey(k)).ToList());
  }
 }
 internal sealed class UpgradeJournal {
  readonly UpgradePlan plan;int next;int? inFlight;readonly List<int> applied=new List<int>();public string Phase{get;private set;}="prepared";
  public UpgradeJournal(UpgradePlan plan){this.plan=plan??throw new ArgumentNullException(nameof(plan));}
  public UpgradeStep? Next(){if(Phase!="prepared"&&Phase!="applying")throw new InvalidOperationException("Transaction cannot advance");while(next<plan.Steps.Count&&plan.Steps[next].Kind=="keep")next++;return next==plan.Steps.Count?null:plan.Steps[next];}
  // Caller must durably persist intent BEFORE performing file operation; then acknowledge.
  public int Intent(){if(Next()==null)throw new InvalidOperationException("No next operation");Phase="applying";inFlight=next;return next;}
  public void Applied(int index){if(Phase!="applying"||index!=next||inFlight!=index)throw new InvalidOperationException("Out of order journal acknowledgement");applied.Add(index);inFlight=null;next++;}
  public void FilesVerified(){if(inFlight!=null||Next()!=null)throw new InvalidOperationException("Files not complete");Phase="files-verified";}
  public void RegistrationCommitted(){if(Phase!="files-verified")throw new InvalidOperationException("Cannot register incomplete files");Phase="committed";}
  public IReadOnlyList<UpgradeStep> BeginRollback(){if(Phase=="committed")throw new InvalidOperationException("Committed upgrade requires separate recovery decision");Phase="rollback-required";return applied.Concat(inFlight.HasValue?new[]{inFlight.Value}:Array.Empty<int>()).Reverse().Select(i=>plan.Steps[i]).ToList().AsReadOnly();}
 }
}
