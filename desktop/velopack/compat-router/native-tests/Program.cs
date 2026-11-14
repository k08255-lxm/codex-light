using System.Diagnostics;using System;using System.IO;using System.Reflection;using System.Security.Cryptography;using CodexLight.PublicSetup;
internal static class NativeTests {
 static void MustBlock(Action action){try{action();}catch(IOException){return;}throw new Exception("Lease permitted replacement/write");}
 static int Main(string[] args){try{
  if(args.Length==1&&args[0]=="--lease-child-probe")return 0;
  if(args.Length!=4)throw new ArgumentException("ROUTER_OR_--offline NEW_OUTPUT FRESH_ARCHIVE FRESH_HASH");
  string root=Path.GetFullPath(args[1]);if(Directory.Exists(root)||File.Exists(root))throw new IOException("Existing output refused");Directory.CreateDirectory(root);
  string self=Assembly.GetExecutingAssembly().Location,probe=Path.Combine(root,"read-lease-probe.exe");File.Copy(self,probe);if(File.Exists(self+".config"))File.Copy(self+".config",probe+".config");
  string probeHash;using(var sha=SHA256.Create())using(var input=File.OpenRead(probe))probeHash=VerifiedLease.Hex(sha.ComputeHash(input));
  using(var lease=VerifiedLease.Open(probe,probeHash)){using(var child=Process.Start(new ProcessStartInfo(probe,"--lease-child-probe"){UseShellExecute=false,CreateNoWindow=true})){child.WaitForExit();if(child.ExitCode!=0)throw new Exception("Read lease blocked executable loading");}}Console.WriteLine("PASS harmless child executable loads under read lease");
  bool network=true;
  if(args[0]!="--offline"){
   var download=typeof(RouterWindow).GetMethod("Download",BindingFlags.NonPublic|BindingFlags.Static);string file=Path.Combine(root,"verified-bridge.exe");
   try{download.Invoke(null,new object[]{RouterPolicy.BridgeUrl,RouterPolicy.BridgeHash,file});using(var held=VerifiedLease.Open(file,RouterPolicy.BridgeHash)){MustBlock(()=>File.WriteAllText(file,"tampered"));MustBlock(()=>File.Delete(file));}Console.WriteLine("PASS pinned bridge download and execution lease");}
   catch(TargetInvocationException e){network=false;Console.WriteLine("UNVERIFIED download: "+e.InnerException?.Message);}
  }else Console.WriteLine("SKIP network (offline lease/extract test)");
  string fresh=Path.Combine(root,"fresh.zip");File.Copy(args[2],fresh);
  using(var zip=VerifiedLease.Open(fresh,args[3])){
   MustBlock(()=>File.WriteAllText(fresh,"tampered"));MustBlock(()=>File.Delete(fresh));
   using(var payload=FreshLease.Extract(zip,Path.Combine(root,"fresh"))){
    int count=0;foreach(var member in Directory.GetFiles(Path.Combine(root,"fresh"),"*",SearchOption.AllDirectories)){MustBlock(()=>File.WriteAllText(member,"tampered"));MustBlock(()=>File.Delete(member));count++;}
    if(!File.Exists(payload.Installer)||count<2)throw new Exception("Incomplete wrapper/dependency fixture");Console.WriteLine("PASS fresh archive + "+count+" member leases deny write/delete; no installer executed");
   }
  }
  File.WriteAllText(fresh,"changed after release");try{using(var ignored=VerifiedLease.Open(fresh,args[3])){}throw new Exception("Changed file accepted");}catch(IOException){Console.WriteLine("PASS changed artifact rejected before execution");}
  Console.WriteLine("No UI, installation, registration, user data or updater operation performed.");return network?0:2;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
