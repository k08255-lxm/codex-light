using CodexLight.Migration;
static class StorageTests {
 public static int Run(string root){
  int count=0;void Check(bool ok,string name){if(!ok)throw new Exception(name);count++;}
  void Reject(Action action,string name){bool rejected=false;try{action();}catch(IOException){rejected=true;}Check(rejected,name);}
  var data=Path.Combine(root,"app-data");Directory.CreateDirectory(Path.Combine(data,"state"));Directory.CreateDirectory(Path.Combine(data,"WebView","Default"));Directory.CreateDirectory(Path.Combine(data,"logs"));Directory.CreateDirectory(Path.Combine(data,"recovery"));File.WriteAllBytes(Path.Combine(data,"recovery","saved.bin"),new byte[]{4,5,6});
  File.WriteAllBytes(Path.Combine(data,"state","a.bin"),new byte[]{0,1,2,255});File.WriteAllText(Path.Combine(data,"WebView","Default","Cookies"),"fixture-profile");File.WriteAllText(Path.Combine(data,"logs","old.log"),"excluded");
  File.WriteAllText(Path.Combine(data,"close-behavior.json"),"{\"version\":1,\"behavior\":\"ask\"}");foreach(var name in new[]{"SetupArchives","StorageRecovery"}){Directory.CreateDirectory(Path.Combine(data,name));File.WriteAllBytes(Path.Combine(data,name,"saved.zip"),new byte[]{7,8,9});}
  var manifest=MigrationStorage.Capture(data);Check(manifest.Files.Length==6&&manifest.Excluded.SequenceEqual(new[]{"logs"}),"profile retained/logs explicitly excluded");
  var snapshot=Path.Combine(root,"snapshot");MigrationStorage.CopySnapshot(manifest,snapshot);MigrationStorage.VerifySnapshot(manifest,snapshot);count++;
  var restored=Path.Combine(root,"restored");MigrationStorage.RestoreToFreshDirectory(manifest,snapshot,restored);Check(File.ReadAllBytes(Path.Combine(restored,"state","a.bin")).SequenceEqual(new byte[]{0,1,2,255}),"restored exact bytes");
  Reject(()=>MigrationStorage.RestoreToFreshDirectory(manifest,snapshot,data),"in-place rejected");Reject(()=>MigrationStorage.CopySnapshot(manifest,Path.Combine(data,"nested")),"nested backup rejected");
  File.WriteAllText(Path.Combine(data,"unknown.txt"),"unknown");Reject(()=>MigrationStorage.Capture(data),"unknown app data rejected");File.Delete(Path.Combine(data,"unknown.txt"));
  File.WriteAllText(Path.Combine(snapshot,"unknown.txt"),"unknown");Reject(()=>MigrationStorage.VerifySnapshot(manifest,snapshot),"unknown snapshot rejected");File.Delete(Path.Combine(snapshot,"unknown.txt"));
  File.WriteAllText(Path.Combine(snapshot,"state","a.bin"),"corrupt");Reject(()=>MigrationStorage.VerifySnapshot(manifest,snapshot),"corruption rejected");
  Reject(()=>MigrationStorage.Canonical(Path.Combine(root,".codex","config.toml")),"Codex root excluded");
  File.WriteAllText(Path.Combine(data,"state","a.bin"),"changed");Reject(()=>MigrationStorage.CopySnapshot(manifest,Path.Combine(root,"changed-copy")),"source mutation rejected");
  var receipt=Path.Combine(root,"receipt.json");MigrationStorage.AtomicReceipt(receipt,new {Phase="old"});var old=File.ReadAllBytes(receipt);
  Reject(()=>MigrationStorage.AtomicReceipt(receipt,new {Phase="new"},()=>throw new IOException("injected precommit failure")),"receipt failure injected");Check(old.SequenceEqual(File.ReadAllBytes(receipt)),"old receipt preserved");Check(!Directory.GetFiles(root,".receipt-*.tmp").Any(),"temporary receipt cleaned");MigrationStorage.AtomicReceipt(receipt,new {Phase="new"});Check(File.ReadAllText(receipt).Contains("new"),"atomic update succeeded");
  Check(MigrationStorage.RequiredBytes(manifest,100,20,30,0)==manifest.Files.Sum(x=>x.Bytes)+250,"manifest sized budget");bool overflow=false;try{MigrationStorage.RequiredBytes(manifest,long.MaxValue,0,0,0);}catch(OverflowException){overflow=true;}Check(overflow,"budget overflow rejected");
  string oldRoot=Path.Combine(root,"old-program"),newRoot=Path.Combine(root,"new-program");
  bool OtherThreadCanAcquire(){bool ok=false;var t=new Thread(()=>{try{using var l=MigrationStorage.AcquireInstallRoots(oldRoot,newRoot,"fixture-sid");ok=true;}catch(IOException){}});t.Start();t.Join();return ok;}
  using(MigrationStorage.AcquireInstallRoots(oldRoot,newRoot,"fixture-sid")){Check(!OtherThreadCanAcquire(),"competing root lock rejected");}Check(OtherThreadCanAcquire(),"all roots released");
  Console.WriteLine($"PASS {count} storage safety checks; fixture-only files.");return count;
 }
}
