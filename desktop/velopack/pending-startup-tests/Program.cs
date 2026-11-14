using Velopack;
using Velopack.Locators;
if(args.Length!=2)throw new ArgumentException("Supply isolated old/current and newer full nupkg fixture paths");
var root=Path.Combine(Path.GetTempPath(),"CodexLightPendingFixture-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
var files=args.Select(file=>{var target=Path.Combine(root,Path.GetFileName(file));File.Copy(file,target);return target;}).ToArray();
var hashes=files.Select(file=>Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(file)))).ToArray();
var spy=new ProcessSpy();
var locator=new FixtureLocator(root,spy);
for(int startup=0;startup<2;startup++){
 VelopackApp.Build().SetArgs(Array.Empty<string>()).SetLocator(locator).SetAutoApplyOnStartup(false).Run();
 if(spy.Starts!=0||spy.Exits!=0)throw new Exception("Startup attempted auto apply/exit");
 if(locator.GetLatestLocalFullPackage()?.Version.ToString()!="0.4.901")throw new Exception("Pending package lost");
 for(int i=0;i<files.Length;i++)if(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(files[i])))!=hashes[i])throw new Exception("Current/pending package changed");
 Console.WriteLine($"PASS simulated startup {startup+1}: no updater start/exit, current+pending unchanged");
}
Console.WriteLine("Fixture: "+root);
sealed class FixtureLocator(string root,ProcessSpy spy):TestVelopackLocator("CodexLightBenchPreviewIsolated","0.4.900",root,root,root,Path.Combine(root,"Update.exe"),processPath:Path.Combine(root,"Probe.exe")){
 public override IProcessImpl Process=>spy;
}
sealed class ProcessSpy:IProcessImpl{
 public int Starts,Exits;
 public string GetCurrentProcessPath()=>Environment.ProcessPath!;
 public uint GetCurrentProcessId()=>(uint)Environment.ProcessId;
 public void StartProcess(string exePath,IEnumerable<string> args,string workDir,bool showWindow){Starts++;throw new Exception("Process start blocked in fixture");}
 public void Exit(int exitCode){Exits++;throw new Exception("Process exit blocked in fixture");}
}
