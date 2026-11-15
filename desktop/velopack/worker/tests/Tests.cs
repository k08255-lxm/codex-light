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
// Scoped occupancy decisions do not inspect unrelated protected processes.
WorkerProcesses.CheckHolders(Array.Empty<uint>());Pass(true);
Reject(()=>WorkerProcesses.CheckHolders(new uint[]{101}));
Reject(()=>WorkerProcesses.CheckHolders(new uint[]{(uint)Environment.ProcessId}));
if(args.Length==2&&args[0]=="--probe-resources"){
 var resources=WorkerProcesses.InstalledResources(args[1]);
 Console.WriteLine($"Resource probe: {resources.Length} files; holders: {string.Join(",",WorkerProcesses.Holders(resources))}");
}
Pass(!WorkerPolicy.MayApply(false,false,false,TimeSpan.Zero));
Pass(!WorkerPolicy.MayApply(false,true,false,TimeSpan.Zero));
Pass(WorkerPolicy.MayApply(false,true,true,TimeSpan.Zero));
Reject(()=>WorkerPolicy.MayApply(true,true,true,TimeSpan.Zero));
Reject(()=>WorkerPolicy.MayApply(false,false,true,TimeSpan.Zero));
Reject(()=>WorkerPolicy.MayApply(false,true,true,TimeSpan.FromMinutes(6)));
Console.WriteLine($"PASS {count} total checks including commit/cancel/exit/expiry matrix.");

if(args.Contains("--native-fixture")){
 var root=Path.Combine(AppContext.BaseDirectory,"CodeCang-occupancy-"+Guid.NewGuid().ToString("N"));
 Directory.CreateDirectory(Path.Combine(root,"current"));
 var resource=Path.Combine(root,"current","fixture.bin");File.WriteAllText(resource,"synthetic fixture");
 var resources=WorkerProcesses.InstalledResources(root);Pass(resources.Length==1);
 WorkerProcesses.CheckHolders(WorkerProcesses.Holders(resources));Pass(true);
 using(var held=File.Open(resource,FileMode.Open,FileAccess.ReadWrite,FileShare.None)){
  var holders=WorkerProcesses.Holders(resources);Pass(holders.Contains((uint)Environment.ProcessId));Reject(()=>WorkerProcesses.CheckHolders(holders));
 }
 WorkerProcesses.CheckHolders(WorkerProcesses.Holders(resources));Pass(true);
 Console.WriteLine($"PASS {count} including native idle/held/released fixture. No updater or installation touched. Fixture: {root}");
}
// Bootstrap target identity gates: no process launch or installed files involved.
BootstrapPolicy.CheckTarget(@"C:\Data\CodexLightDesktop",@"C:\Data","0.4.7",new string('b',64),"0.4.7",new string('b',64));Pass(true);
Reject(()=>BootstrapPolicy.CheckTarget(@"C:\Data\Other",@"C:\Data","0.4.7",new string('b',64),"0.4.7",new string('b',64)));
Reject(()=>BootstrapPolicy.CheckTarget(@"C:\Data\CodexLightDesktop",@"C:\Data","0.4.6",new string('b',64),"0.4.7",new string('b',64)));
Reject(()=>BootstrapPolicy.CheckTarget(@"C:\Data\CodexLightDesktop",@"C:\Data","0.4.7",new string('a',64),"0.4.7",new string('b',64)));
Reject(()=>BootstrapPolicy.CheckTarget(@"C:\Data\CodexLightDesktop",@"C:\Data","0.4.7",new string('b',64),"",""));
Console.WriteLine($"PASS {count} checks including bootstrap identity gates. No updater executed.");
// Synthetic post-apply verification; all files live under test build output.
var fixture=Path.Combine(AppContext.BaseDirectory,"bootstrap-fixture-"+Guid.NewGuid().ToString("N"));var current=Path.Combine(fixture,"install","current");Directory.CreateDirectory(current);var data=Path.Combine(fixture,"data","CodexLight");Directory.CreateDirectory(data);
string Manifest(string version)=>$"<package xmlns='http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd'><metadata><id>CodexLightDesktop</id><mainExe>CodexLight.exe</mainExe><os>win</os><channel>win</channel><rid>win-x64</rid><version>{version}</version></metadata></package>";
File.WriteAllText(Path.Combine(fixture,"install","Update.exe"),"not executable");File.WriteAllText(Path.Combine(current,"CodexLight.exe"),"not executable");File.WriteAllText(Path.Combine(current,"sq.version"),Manifest("0.4.7"));
var zipPath=Path.Combine(fixture,"fixture.zip");using(var z=System.IO.Compression.ZipFile.Open(zipPath,System.IO.Compression.ZipArchiveMode.Create)){foreach(var file in new[]{"CodexLight.exe","sq.version"}){var entry=z.CreateEntry("lib/app/"+file);using var output=entry.Open();using var source=File.OpenRead(Path.Combine(current,file));source.CopyTo(output);}}
// Real Velopack layout: generated stub and updater live at install root.
File.WriteAllText(Path.Combine(fixture,"install","Codex Light.exe"),"stub fixture");
using(var z=System.IO.Compression.ZipFile.Open(zipPath,System.IO.Compression.ZipArchiveMode.Update)){
 foreach(var pair in new[]{("Squirrel.exe","Update.exe"),("Codex Light_ExecutionStub.exe","Codex Light.exe")}){
  var entry=z.CreateEntry("lib/app/"+pair.Item1);using var output=entry.Open();using var source=File.OpenRead(Path.Combine(fixture,"install",pair.Item2));source.CopyTo(output);
 }
}
var prior=new VelopackInstalledIdentity(Path.Combine(fixture,"install"),current,Path.Combine(fixture,"install","Update.exe"),"0.4.4",data);
using(var package=new ValidatedVelopackPackage(File.OpenRead(zipPath),zipPath,new string('a',64),"0.4.7",prior)){
 BootstrapPolicy.VerifyApplied(package);Pass(true);
 foreach(var pair in new[]{("Update.exe","not executable"),("Codex Light.exe","stub fixture")}){
  var file=Path.Combine(fixture,"install",pair.Item1);File.WriteAllText(file,"corrupt");Reject(()=>BootstrapPolicy.VerifyApplied(package));
  File.Delete(file);Reject(()=>BootstrapPolicy.VerifyApplied(package));File.WriteAllText(file,pair.Item2);
 }
 BootstrapPolicy.VerifyApplied(package);Pass(true);
 File.WriteAllText(Path.Combine(current,"CodexLight.exe"),"corrupt");Reject(()=>BootstrapPolicy.VerifyApplied(package));
 File.WriteAllText(Path.Combine(current,"CodexLight.exe"),"not executable");File.WriteAllText(Path.Combine(current,"sq.version"),Manifest("0.4.4"));Reject(()=>BootstrapPolicy.VerifyApplied(package));
}
Console.WriteLine($"PASS {count} including isolated installed-version and byte verification. No real executable or installation accessed.");

if(args.Length==4&&args[0]=="--verify-installed-readonly"){
 var archive=Path.GetFullPath(args[1]);var expected=args[2];using var held=File.Open(archive,FileMode.Open,FileAccess.Read,FileShare.Read);
 if(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(held)).ToLowerInvariant()!=expected)throw new Exception("Read-only proof package hash mismatch");held.Position=0;
 var identity=VelopackPackage.ReadInstalled(Path.Combine(Path.GetFullPath(args[3]),"current"));
 using var proof=new ValidatedVelopackPackage(held,archive,expected,"0.4.7",identity);
 BootstrapPolicy.VerifyApplied(proof);Console.WriteLine("PASS read-only real installed 0.4.7 payload including relocated stub/updater matches pinned package. No install or data writes.");
}
VelopackPackage.RequireTargetVersion("0.4.7","0.4.6",null);Pass(true);
Reject(()=>VelopackPackage.RequireTargetVersion("0.4.7","0.4.7",null));
Reject(()=>VelopackPackage.RequireTargetVersion("0.4.6","0.4.7",null));
VelopackPackage.RequireTargetVersion("0.4.7","0.4.7","0.4.7");Pass(true);
VelopackPackage.RequireTargetVersion("0.4.7","0.4.6","0.4.7");Pass(true);
Reject(()=>VelopackPackage.RequireTargetVersion("0.4.6","0.4.7","0.4.6"));
Reject(()=>VelopackPackage.RequireTargetVersion("0.4.7","0.4.7","0.4.8"));
Reject(()=>VelopackPackage.RequireTargetVersion("0.4.7","0.4.7",""));
Reject(()=>VelopackPackage.ValidateRepair("unused",new string('a',64),prior,"0.4.7",new string('b',64)));
Console.WriteLine($"PASS {count} including strict normal-update/scoped-repair matrix.");
// Exercise full archive validation at equal version, not just comparison logic.
File.WriteAllText(Path.Combine(current,"sq.version"),Manifest("0.4.7"));
var equalIdentity=VelopackPackage.ReadInstalled(current,Path.GetDirectoryName(data));
var fullZip=Path.Combine(fixture,"full-fixture.zip");
using(var zip=System.IO.Compression.ZipFile.Open(fullZip,System.IO.Compression.ZipArchiveMode.Create)){
 foreach(var name in new[]{"CodexLightDesktop.nuspec","lib/app/sq.version","lib/app/CodexLight.exe","lib/app/CodexLight.dll","lib/app/app/src/desktop-backend.mjs"}){
  using var writer=new StreamWriter(zip.CreateEntry(name).Open());writer.Write(name.EndsWith(".nuspec")||name.EndsWith("sq.version")?Manifest("0.4.7"):"synthetic, not executable");
 }
}
string fullHash;using(var input=File.OpenRead(fullZip))fullHash=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(input)).ToLowerInvariant();
var fullCache=Path.Combine(data,"Updates","0.4.7-"+fullHash[..16]);Directory.CreateDirectory(fullCache);var fullPath=Path.Combine(fullCache,"CodexLightDesktop-0.4.7-full.nupkg");File.Copy(fullZip,fullPath);
Reject(()=>VelopackPackage.Validate(fullPath,fullHash,equalIdentity));
using(var verified=VelopackPackage.ValidateRepair(fullPath,fullHash,equalIdentity,"0.4.7",fullHash)){Pass(verified.Version=="0.4.7");}
Reject(()=>VelopackPackage.ValidateRepair(fullPath,fullHash,equalIdentity,"0.4.8",fullHash));
Reject(()=>VelopackPackage.ValidateRepair(fullPath,fullHash,equalIdentity,"0.4.7",new string('b',64)));
Console.WriteLine($"PASS {count} checks including complete equal-version full-package validation. No actual apply.");
