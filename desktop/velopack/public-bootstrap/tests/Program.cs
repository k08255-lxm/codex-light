using CodexLight.PublicSetup;
int count=0;
void Check(Route actual,Route expected){if(actual!=expected)throw new Exception($"Expected {expected}, got {actual}");count++;}
Check(Routing.Choose(0,false,false,false,false,false),Route.Fresh);
Check(Routing.Choose(1,true,false,false,false,true),Route.Migrate);
Check(Routing.Choose(0,false,true,true,false,true),Route.Velopack);
foreach(int n in new[]{-1,2})Check(Routing.Choose(n,true,false,false,false,true),Route.Blocked);
Check(Routing.Choose(1,false,false,false,false,true),Route.Blocked);
Check(Routing.Choose(1,true,true,true,false,true),Route.Blocked);
Check(Routing.Choose(0,true,false,false,false,true),Route.Blocked);
Check(Routing.Choose(0,false,true,false,false,true),Route.Blocked);
Check(Routing.Choose(0,false,false,true,false,true),Route.Blocked);
Check(Routing.Choose(0,false,false,false,false,true),Route.Blocked);
Check(Routing.Choose(0,false,false,false,true,false),Route.Blocked);

foreach(var location in new[]{@"C:\Users\Example\AppData\Local\Programs\CodexLight",@"D:\Custom Apps\Codex Light"}){
 var resolved=Routing.ValidateLegacyRoot(location,_=>true,p=>p.EndsWith("CodexLight.exe"));
 if(resolved!=location)throw new Exception("Registered root changed");
 Check(Routing.Choose(1,resolved.Length>0,false,false,false,true),Route.Migrate);
}
foreach(var location in new[]{"",@"C:relative",@"\relative",@"\\server\share\app",@"C:\"}){try{Routing.ValidateLegacyRoot(location,_=>true,_=>true);throw new Exception("Invalid registered root accepted");}catch(System.IO.IOException){count++;}}
foreach(var missing in new[]{"directory","exe"}){try{Routing.ValidateLegacyRoot(@"D:\Custom Apps\Codex Light",_=>missing!="directory",_=>missing!="exe");throw new Exception("Missing installation accepted");}catch(System.IO.IOException){count++;}}
Console.WriteLine($"PASS {count} installation routing cases; no installation executed.");

var host=new Fake();if(BootstrapFlow.Run(host)!=0||string.Join(",",host.Calls)!="stage,retire,outcome")throw new Exception("Flow order");
host=new Fake{Outcome="RestartRequired"};if(BootstrapFlow.Run(host)!=3010)throw new Exception("Restart treated as complete");
foreach(var step in new[]{"stage","retire","outcome"}){host=new Fake{Fail=step};try{BootstrapFlow.Run(host);throw new Exception("Failure swallowed");}catch(System.IO.IOException){}if(step=="stage"&&host.Calls.Contains("retire"))throw new Exception("Retired after failed stage");}
host=new Fake{Outcome="RecoveryRequired"};try{BootstrapFlow.Run(host);throw new Exception("False success");}catch(InvalidOperationException){}
Console.WriteLine("PASS 6 automatic flow cases, fake steps only");
sealed class Fake:IMigrationSteps {public List<string> Calls=new();public string Fail="",Outcome="OldMsiRetired";void Step(string s){Calls.Add(s);if(s==Fail)throw new System.IO.IOException(s);}public string Stage(){Step("stage");return "receipt";}public void Retire(string r){if(r!="receipt")throw new Exception("Receipt identity lost");Step("retire");}public string ReadOutcome(string r){Step("outcome");return Outcome;}}
