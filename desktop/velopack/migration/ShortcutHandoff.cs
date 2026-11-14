using System.Runtime.InteropServices;
namespace CodexLight.Migration;
internal interface IShortcutCodec { string Target(string path); void Write(string path,string target); }
internal sealed class ShellShortcutCodec:IShortcutCodec {
 public string Target(string path)=>Use(path,null);
 public void Write(string path,string target)=>Use(path,target);
 static string Use(string path,string? target){dynamic shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!)!;try{dynamic link=shell.CreateShortcut(path);try{if(target!=null){link.TargetPath=target;link.WorkingDirectory=Path.GetDirectoryName(target);link.Description="Codex Light";link.Save();}return (string)link.TargetPath;}finally{Marshal.FinalReleaseComObject(link);}}finally{Marshal.FinalReleaseComObject(shell);}}
}
// A verified fallback exists before MSI removal. Never restore an old shortcut to a removed executable.
internal sealed class ShortcutHandoff {
 readonly string programs,oldExe,stub,recovery,formal,fallback;
 readonly IShortcutCodec codec;
 readonly Dictionary<string,string> owned=new(StringComparer.OrdinalIgnoreCase);
 public ShortcutHandoff(string programs,string oldExe,string stub,string recovery,IShortcutCodec? codec=null){this.programs=MigrationStorage.Canonical(programs);this.oldExe=oldExe;this.stub=stub;this.recovery=recovery;this.codec=codec??new ShellShortcutCodec();formal=Path.Combine(programs,"Codex Light.lnk");fallback=Path.Combine(programs,"Codex Light (Velopack).lnk");}
 bool Is(string a,string b)=>string.Equals(Path.GetFullPath(a),Path.GetFullPath(b),StringComparison.OrdinalIgnoreCase);
 bool Ours(string path){var target=codec.Target(path);return !string.IsNullOrWhiteSpace(target)&&(Is(target,oldExe)||Is(target,stub));}
 IEnumerable<string> Links(string directory){MigrationStorage.Canonical(directory);foreach(var p in Directory.EnumerateFileSystemEntries(directory)){MigrationStorage.Canonical(p);if(Directory.Exists(p)){foreach(var child in Links(p))yield return child;}else if(Path.GetExtension(p).Equals(".lnk",StringComparison.OrdinalIgnoreCase))yield return p;}}
 public void Prepare(){
  if(File.Exists(Path.Combine(recovery,"shortcut-handoff-plan.json")))throw new IOException("Prior shortcut handoff exists; reconcile before retry");
  if(!File.Exists(stub))throw new IOException("Verified new shortcut target missing");
  foreach(var p in new[]{formal,fallback}){MigrationStorage.Canonical(p);if(Directory.Exists(p)||File.Exists(p)&&!Ours(p))throw new IOException("Foreign shortcut occupies migration entry: "+p);}
  foreach(var path in Links(programs)){
   if(!new[]{"Codex Light.lnk","Codex Light (Velopack).lnk"}.Contains(Path.GetFileName(path),StringComparer.OrdinalIgnoreCase))continue;
   MigrationStorage.Canonical(path);if(!Ours(path))continue;owned[path]=MigrationCoordinator.Hash(path);
  }
  var backup=Path.Combine(recovery,"shortcut-backup");Directory.CreateDirectory(backup);int i=0;foreach(var p in owned){var dest=Path.Combine(backup,(i++)+".lnk");File.Copy(p.Key,dest,false);if(MigrationCoordinator.Hash(dest)!=p.Value)throw new IOException("Shortcut backup mismatch");}
  MigrationStorage.AtomicReceipt(Path.Combine(recovery,"shortcut-handoff-plan.json"),new{Phase="Prepared",Formal=formal,Fallback=fallback,Target=stub,Originals=owned});
  Publish(fallback); // Successful MSI uninstall can remove every legacy-owned entry, never this distinct fallback.
 }
 void Publish(string path){
  if(File.Exists(path)&&(!owned.TryGetValue(path,out var hash)||MigrationCoordinator.Hash(path)!=hash)){
   if(Is(codec.Target(path),stub))return;throw new IOException("Shortcut changed concurrently");
  }
  var temp=Path.Combine(programs,".codexlight-"+Guid.NewGuid().ToString("N")+".lnk");try{codec.Write(temp,stub);if(!Is(codec.Target(temp),stub))throw new IOException("Shortcut target verification failed");if(File.Exists(path))File.Replace(temp,path,null);else File.Move(temp,path,false);owned[path]=MigrationCoordinator.Hash(path);}finally{if(File.Exists(temp))File.Delete(temp);}
 }
 public void Complete(){
  Publish(formal);if(!Is(codec.Target(formal),stub))throw new IOException("Formal shortcut not verified");
  foreach(var p in owned.Where(p=>!Is(p.Key,formal))){if(!File.Exists(p.Key))continue;if(MigrationCoordinator.Hash(p.Key)!=p.Value)throw new IOException("Shortcut changed; not deleting it");File.Delete(p.Key);}
  MigrationStorage.AtomicReceipt(Path.Combine(recovery,"shortcut-handoff.json"),new{Phase="Completed",Formal=formal,Target=stub,Sha256=MigrationCoordinator.Hash(formal)});
 }
 public void PreserveEntry(){foreach(var p in new[]{formal,fallback})if(File.Exists(p)&&Is(codec.Target(p),stub))return;Publish(fallback);}
}



