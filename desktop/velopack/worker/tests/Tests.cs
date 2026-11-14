using CodexLight.Desktop;
using System.Text.Json;
int count=0;
void Pass(bool value){if(!value)throw new Exception("Assertion failed");count++;}
void Reject(Action f){try{f();}catch{count++;return;}throw new Exception("Expected refusal");}
string Json()=>JsonSerializer.Serialize(new{root=@"C:\Apps\CodexLight",package=@"C:\Data\CodexLight\Updates\1.2.3-abcdef\full.nupkg",hash=new string('a',64),parentPid=123,parentStartUtc=new DateTime(2026,1,1,0,0,0,DateTimeKind.Utc).ToString("O"),packageId="CodexLightDesktop"});
var r=WorkerPolicy.Parse(Json());Pass(r.ParentPid==123&&r.PackageId=="CodexLightDesktop");
Reject(()=>WorkerPolicy.Parse(Json().Replace("123","0")));
Reject(()=>WorkerPolicy.Parse(Json().Replace("CodexLightDesktop","Other")));
Reject(()=>WorkerPolicy.Parse(Json().Replace("\"parentPid\":123","\"parentPid\":123,\"parentPid\":456")));
Reject(()=>WorkerPolicy.Parse(Json().TrimEnd('}')+",\"unexpected\":true}"));
Reject(()=>WorkerPolicy.Parse(Json().Replace("0000000Z","0000000+08:00")));
Reject(()=>WorkerPolicy.Canonical(@"\\server\share\x"));
Reject(()=>WorkerPolicy.Canonical(@"C:relative"));
Reject(()=>WorkerPolicy.ReceiptPath(new[]{"--apply","x"},@"C:\Data"));
Reject(()=>WorkerPolicy.ReceiptPath(new[]{"--receipt",@"C:\Data\CodexLight\Updates\Apply\..\outside.json"},@"C:\Data"));
Reject(()=>WorkerPolicy.ReceiptPath(new[]{"--receipt",@"C:\Data\CodexLight\Updates\Apply\bad.json"},@"C:\Data"));
Pass(WorkerPolicy.ReceiptPath(new[]{"--receipt",@"C:\Data\CodexLight\Updates\Apply\"+new string('a',32)+".json"},@"C:\Data").EndsWith(".json"));
Pass(WorkerPolicy.Within(@"C:\Apps\CodexLight\current\app.exe",@"C:\Apps\CodexLight"));
Pass(!WorkerPolicy.Within(@"C:\Apps\CodexLightOther\app.exe",@"C:\Apps\CodexLight"));
Reject(()=>WorkerPolicy.CheckWorker(@"C:\Apps\CodexLight\current\worker.exe",@"C:\Apps\CodexLight"));
Console.WriteLine($"PASS {count} pure worker policy checks. No updater/process launched.");
// Synthetic process sets: no real processes started, stopped, or enumerated.
WorkerProcesses.Check(new[]{0,4,42,101,102},42,@"C:\Apps\CodexLight",pid=>pid==101?@"C:\Windows\System32\service.exe":null);Pass(true);
Reject(()=>WorkerProcesses.Check(new[]{101},42,@"C:\Apps\CodexLight",_=>@"C:\Apps\CodexLight\current\node.exe"));
Reject(()=>WorkerProcesses.Check(new[]{101},42,@"C:\Apps\CodexLight",_=>throw new System.ComponentModel.Win32Exception(5)));
Reject(()=>WorkerProcesses.Check(new[]{101},42,@"C:\Apps\CodexLight",_=>""));
WorkerProcesses.Check(new[]{101},42,@"C:\Apps\CodexLight",_=>@"C:\Apps\CodexLightOther\node.exe");Pass(true);
Console.WriteLine($"PASS {count} total pure checks including synthetic process decisions.");
if(args.Contains("--probe-processes")){
 int readable=0,unknown=0,exited=0;foreach(var p in System.Diagnostics.Process.GetProcesses())using(p){if(p.Id is 0 or 4)continue;try{if(WorkerProcesses.ImageOrExited(p.Id)==null)exited++;else readable++;}catch(System.ComponentModel.Win32Exception){unknown++;}}
 Console.WriteLine($"Read-only process probe: readable={readable}; exited={exited}; unknown={unknown}. Unknown means apply BLOCKED, never skipped.");
}
Pass(!WorkerPolicy.MayApply(false,false,false,TimeSpan.Zero));
Pass(!WorkerPolicy.MayApply(false,true,false,TimeSpan.Zero));
Pass(WorkerPolicy.MayApply(false,true,true,TimeSpan.Zero));
Reject(()=>WorkerPolicy.MayApply(true,true,true,TimeSpan.Zero));
Reject(()=>WorkerPolicy.MayApply(false,false,true,TimeSpan.Zero));
Reject(()=>WorkerPolicy.MayApply(false,true,true,TimeSpan.FromMinutes(6)));
Console.WriteLine($"PASS {count} total checks including commit/cancel/exit/expiry matrix.");
