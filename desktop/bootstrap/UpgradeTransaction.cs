using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
namespace CodexLight.Bootstrap {
 // Fixed application registry key adapter only; never accepts a key/path from journal input.
 internal interface IUpgradeRegistration {string Read();void Write(string value);}
 [DataContract]internal sealed class UpgradeJournalRecord {
  [DataMember(Order=0)]public int Version=1;
  [DataMember(Order=1)]public string PlanHash="";
  [DataMember(Order=2)]public string TransactionId="";
  [DataMember(Order=3)]public string Phase="prepared";
  [DataMember(Order=4)]public int Completed=0;
  [DataMember(Order=5)]public int Intent=-1;
  [DataMember(Order=6)]public string PreviousRegistration="";
  [DataMember(Order=7)]public string NextRegistration="";
 }
 internal sealed class UpgradeTransaction {
  readonly string root,source;readonly UpgradePlan plan;readonly IUpgradeRegistration registry;readonly Func<bool> appRunning;readonly Action<string> checkpoint;
  readonly List<UpgradeStep> changes;readonly string journalPath;readonly string planHash;
  public UpgradeTransaction(string root,string source,UpgradePlan plan,IUpgradeRegistration registry,Func<bool> appRunning,Action<string>? checkpoint=null){
   this.root=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);this.source=Path.GetFullPath(source).TrimEnd(Path.DirectorySeparatorChar);this.plan=plan;this.registry=registry;this.appRunning=appRunning;this.checkpoint=checkpoint??(_=>{});
   // A Linux temporary-root mapping is solely for synthetic tests. Windows binds exact target.
   if(Environment.OSVersion.Platform==PlatformID.Win32NT&&!string.Equals(this.root,plan.Target,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Target/root mismatch");
   if(string.Equals(this.root,this.source,StringComparison.OrdinalIgnoreCase)||this.source.StartsWith(this.root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Source must be outside installation");
   changes=plan.Steps.Where(x=>x.Kind!="keep").ToList();journalPath=Path.Combine(this.root,"CodexLight.upgrade-journal.json");
   var text=new StringBuilder(plan.Target+"\n"+plan.ReceiptHash+"\n");foreach(var step in changes)text.Append(step.Kind).Append('\0').Append(step.Path).Append('\0').Append(step.Before?.Sha256).Append('\0').Append(step.After?.Sha256).Append('\n');planHash=Hash(Encoding.UTF8.GetBytes(text.ToString()));
  }
  static string Hash(byte[] data){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(data)).Replace("-","").ToLowerInvariant();}
  static byte[] Serialize(UpgradeJournalRecord journal){using(var stream=new MemoryStream()){new DataContractJsonSerializer(typeof(UpgradeJournalRecord)).WriteObject(stream,journal);return stream.ToArray();}}
  static void NoLinks(string full){string? current=full;while(!string.IsNullOrEmpty(current)){if(File.Exists(current)||Directory.Exists(current)){if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("Reparse paths forbidden");}current=Path.GetDirectoryName(current);}}
  string Inside(string directory,string relative){UpgradePlanner.ValidatePath(relative);var result=Path.GetFullPath(Path.Combine(directory,relative.Replace('/',Path.DirectorySeparatorChar)));if(!result.StartsWith(directory+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Path escaped transaction root");NoLinks(result);return result;}
  string Workspace(UpgradeJournalRecord j){return Inside(root,"CodexLight.upgrade-"+j.TransactionId);}
  bool Match(string file,UpgradeFile expected){NoLinks(file);return File.Exists(file)&&new FileInfo(file).Length==expected.Size&&string.Equals(BoundedFile.Hash(file,expected.Size),expected.Sha256,StringComparison.OrdinalIgnoreCase);}
  void EnsureStopped(){if(appRunning())throw new InvalidOperationException("Application is running; no process is killed");NoLinks(root);NoLinks(source);}
  void Save(UpgradeJournalRecord j){NoLinks(journalPath);string temp=journalPath+".new";NoLinks(temp);using(var file=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){byte[] bytes=Serialize(j);file.Write(bytes,0,bytes.Length);file.Flush(true);}if(File.Exists(journalPath)){File.Replace(temp,journalPath,null);}else File.Move(temp,journalPath);}
  UpgradeJournalRecord Load(){NoLinks(journalPath);var bytes=BoundedFile.Read(journalPath,256*1024);if(bytes.Length>256*1024)throw new InvalidOperationException("Journal too large");UpgradeJournalRecord j;using(var stream=new MemoryStream(bytes))j=(UpgradeJournalRecord)new DataContractJsonSerializer(typeof(UpgradeJournalRecord)).ReadObject(stream)!;
   // Only this application's exact canonical journal is accepted. Unknown/duplicate fields fail.
   if(!Serialize(j).SequenceEqual(bytes)||j.Version!=1||j.PlanHash!=planHash||!Guid.TryParseExact(j.TransactionId,"N",out _)||j.Completed<0||j.Completed>changes.Count||j.Intent< -1||j.Intent>=changes.Count||j.PreviousRegistration==null||j.PreviousRegistration.Length>65536||j.NextRegistration==null||j.NextRegistration.Length>65536||!new[]{"prepared","applying","files-verified","registering","committed","rolling-back","rolled-back"}.Contains(j.Phase))throw new InvalidOperationException("Journal invalid or belongs to another plan; nothing recovered");return j;
  }
  public void Execute(bool confirmed,string nextRegistration){
   if(!confirmed)throw new InvalidOperationException("Upgrade needs explicit confirmation");if(nextRegistration==null||nextRegistration.Length>65536)throw new InvalidOperationException("Invalid application registration snapshot");EnsureStopped();
   string lockPath=Inside(root,"CodexLight.upgrade.lock");using(var maintenance=new FileStream(lockPath,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.None)){
    try{
     if(File.Exists(journalPath))throw new InvalidOperationException("Prior journal requires explicit recovery first");
     if(File.Exists(journalPath+".new"))throw new InvalidOperationException("Incomplete journal save requires review");
     // Check ALL managed files, including unchanged ones, before staging.
     foreach(var step in plan.Steps){string target=Inside(root,step.Path);if(step.Before!=null&&!Match(target,step.Before))throw new InvalidOperationException("Managed target modified or missing");if(step.Before==null&&(File.Exists(target)||Directory.Exists(target)))throw new InvalidOperationException("Unknown target collision");if(step.After!=null&&!Match(Inside(source,step.Path),step.After))throw new InvalidOperationException("Trusted payload hash mismatch");}
     var j=new UpgradeJournalRecord{PlanHash=planHash,TransactionId=Guid.NewGuid().ToString("N"),PreviousRegistration=registry.Read(),NextRegistration=nextRegistration};if(j.PreviousRegistration.Length>65536)throw new InvalidOperationException("Registration snapshot too large");
     string workspace=Workspace(j);if(Directory.Exists(workspace)||File.Exists(workspace))throw new InvalidOperationException("Transaction workspace collision");Directory.CreateDirectory(workspace);Directory.CreateDirectory(Path.Combine(workspace,"new"));Directory.CreateDirectory(Path.Combine(workspace,"old"));
     // Staging failures leave only this isolated workspace; no target file/registry changed.
     for(int i=0;i<changes.Count;i++)if(changes[i].After!=null){string staged=Path.Combine(workspace,"new",i.ToString());BoundedFile.Copy(Inside(source,changes[i].Path),staged,changes[i].After!.Size);if(!Match(staged,changes[i].After!))throw new InvalidOperationException("Staged payload hash mismatch");}
     Save(j);checkpoint("journal-prepared");
     try{
      for(int i=0;i<changes.Count;i++){
       EnsureStopped();var step=changes[i];var target=Inside(root,step.Path);if(step.Before!=null&&!Match(target,step.Before))throw new InvalidOperationException("Target changed after preview");if(step.Before==null&&(File.Exists(target)||Directory.Exists(target)))throw new InvalidOperationException("Unknown file appeared");
       j.Phase="applying";j.Intent=i;Save(j);checkpoint("intent-"+i);
       if(step.Before!=null)File.Move(target,Path.Combine(workspace,"old",i.ToString()));checkpoint("backup-"+i);
       if(step.After!=null){Directory.CreateDirectory(Path.GetDirectoryName(target)!);NoLinks(target);File.Move(Path.Combine(workspace,"new",i.ToString()),target);}checkpoint("install-"+i);
       if(step.After!=null&&!Match(target,step.After))throw new InvalidOperationException("Installed payload hash mismatch");j.Completed=i+1;j.Intent=-1;Save(j);checkpoint("applied-"+i);
      }
      foreach(var step in plan.Steps)if(step.After!=null&&!Match(Inside(root,step.Path),step.After))throw new InvalidOperationException("Final payload verification failed");
      j.Phase="files-verified";Save(j);checkpoint("files-verified");j.Phase="registering";Save(j);registry.Write(nextRegistration);checkpoint("registration-written");j.Phase="committed";Save(j);
     }catch{try{Rollback(j);}catch{throw new InvalidOperationException("Upgrade failed and rollback needs recovery; journal and backups retained");}throw;}
    }finally{maintenance.Close();File.Delete(lockPath);}
   }
  }
  void Rollback(UpgradeJournalRecord j){EnsureStopped();j.Phase="rolling-back";Save(j);string workspace=Workspace(j);
   // Registry is an application-scoped adapter. If modified externally, never overwrite it.
   string current=registry.Read();if(current!=j.PreviousRegistration&&current!=j.NextRegistration)throw new InvalidOperationException("Registration changed externally");if(current!=j.PreviousRegistration)registry.Write(j.PreviousRegistration);
   for(int i=Math.Max(j.Completed-1,j.Intent);i>=0;i--){var step=changes[i];string target=Inside(root,step.Path),backup=Path.Combine(workspace,"old",i.ToString());NoLinks(backup);
    if(File.Exists(backup)){
     if(step.Before==null||!Match(backup,step.Before))throw new InvalidOperationException("Backup ownership/hash invalid");
     if(File.Exists(target)){if(step.After==null||!Match(target,step.After))throw new InvalidOperationException("Target changed during rollback; preserved");File.Delete(target);}else if(Directory.Exists(target))throw new InvalidOperationException("Unknown directory collision during rollback");
     Directory.CreateDirectory(Path.GetDirectoryName(target)!);File.Move(backup,target);
    }else if(step.Before==null){if(File.Exists(target)){if(step.After==null||!Match(target,step.After))throw new InvalidOperationException("Unknown replacement preserved");File.Delete(target);}}
    else if(!Match(target,step.Before))throw new InvalidOperationException("Original and backup unavailable; manual recovery required");
   }
   j.Phase="rolled-back";j.Intent=-1;Save(j);
  }
  public void ValidateRecovery(){var j=Load();NoLinks(Workspace(j));foreach(var step in changes)Inside(root,step.Path);}
  public string Recover(bool confirmed){if(!confirmed)throw new InvalidOperationException("Recovery needs explicit confirmation");EnsureStopped();string lockPath=Inside(root,"CodexLight.upgrade.lock");using(var maintenance=new FileStream(lockPath,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.None)){try{var j=Load();if(j.Phase=="committed"||j.Phase=="rolled-back")return j.Phase;Rollback(j);return "rolled-back";}finally{maintenance.Close();File.Delete(lockPath);}}}
 }
}
