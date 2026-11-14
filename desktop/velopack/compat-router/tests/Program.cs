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

foreach(var url in new[]{"http://github.com/a","https://evil.example/a","https://github.com:444/a","https://u@github.com/a","https://github.com/a#x"}){try{RouterPolicy.Redirect(new Uri(url));throw new Exception("Unsafe URL accepted");}catch(IOException){count++;}}
foreach(var url in new[]{"https://github.com/a","https://release-assets.githubusercontent.com/a?signature=x"})RouterPolicy.Redirect(new Uri(url));
foreach(var path in new[]{"../x","/x","a\\b","a:b","CON","a./b","a//b","a/../b"}){try{RouterPolicy.Member(path);throw new Exception("Unsafe path accepted");}catch(IOException){count++;}}
RouterPolicy.Member("CodexLight-Install.exe");Console.WriteLine($"PASS {count} router cases; no installation executed.");
