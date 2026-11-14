using CodexLight.Migration;
static class ShortcutTests {
 sealed class Codec:IShortcutCodec {public bool Fail; public string Target(string p)=>File.ReadAllText(p);public void Write(string p,string t){if(Fail)throw new IOException("write failed");File.WriteAllText(p,t);}}
 public static int Run(string root){int count=0;void Assert(bool b){if(!b)throw new Exception("Shortcut handoff assertion failed");count++;}
 for(int scenario=0;scenario<5;scenario++){
 var dir=Path.Combine(root,"shortcuts-"+scenario);Directory.CreateDirectory(dir);var programs=Path.Combine(dir,"Programs");Directory.CreateDirectory(programs);var recovery=Path.Combine(dir,"Recovery");Directory.CreateDirectory(recovery);var old=Path.Combine(dir,"old.exe");var stub=Path.Combine(dir,"CodexLight.exe");File.WriteAllText(old,"old");File.WriteAllText(stub,"new");var nested=Path.Combine(programs,"Codex Light");Directory.CreateDirectory(nested);var legacy=Path.Combine(nested,"Codex Light.lnk");File.WriteAllText(legacy,old);var formal=Path.Combine(programs,"Codex Light.lnk");var fallback=Path.Combine(programs,"Codex Light (Velopack).lnk");var codec=new Codec();var h=new ShortcutHandoff(programs,old,stub,recovery,codec);
 if(scenario==2){File.WriteAllText(formal,Path.Combine(dir,"foreign.exe"));try{h.Prepare();throw new Exception("Foreign overwritten");}catch(IOException){}Assert(File.ReadAllText(formal).EndsWith("foreign.exe"));Assert(!File.Exists(fallback));continue;}
 if(scenario==4){File.WriteAllText(formal,stub);File.WriteAllText(fallback,stub);}h.Prepare();Assert(File.ReadAllText(fallback)==stub);Assert(File.ReadAllText(legacy)==old);
 if(scenario==1){h.PreserveEntry();Assert(File.Exists(legacy)&&File.ReadAllText(fallback)==stub);continue;}
 File.Delete(legacy); // simulated normal MSI removal
 if(scenario==3){codec.Fail=true;try{h.Complete();throw new Exception("Failure not injected");}catch(IOException){}h.PreserveEntry();Assert(File.ReadAllText(fallback)==stub);Assert(!File.Exists(formal));continue;}
 h.Complete();Assert(File.ReadAllText(formal)==stub);Assert(Directory.EnumerateFiles(programs,"*.lnk",SearchOption.AllDirectories).Count()==1);Assert(File.Exists(Path.Combine(recovery,"shortcut-backup","0.lnk")));
 }
 Console.WriteLine($"PASS {count} shortcut handoff checks; fake links only");return count;
 }
}

