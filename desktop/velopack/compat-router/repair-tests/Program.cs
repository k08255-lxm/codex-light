using System;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using CodexLight.PublicSetup;
namespace CodexLight.PublicSetup {
 internal static class Pins {internal const string Version="0.4.7";}
 internal static class RepairPins {internal const string PackageHash="0000000000000000000000000000000000000000000000000000000000000000",HelperHash=PackageHash;}
}
internal static class Tests {
 static int count;
 static void A(bool b){if(!b)throw new Exception("Assertion failed");count++;}
 static void Block(Action a){try{a();}catch(IOException){count++;return;}throw new Exception("Unsafe input accepted");}
 static int Main(string[] args){
  string good="{\"ready\":true,\"parentPid\":123,\"parentStartUtc\":\"time\",\"packageId\":\"CodexLightDesktop\",\"hash\":\"hash\"}";
  A(Repair.Ready(good,123,"time","hash"));
  foreach(var bad in new[]{good.Replace("true","false"),good.Replace("123","124"),good.Replace("time","wrong"),good.Replace("Desktop","Other"),good.Replace("hash\"}","wrong\"}"),good.Replace("{","{\"extra\":1,"),good.Replace("{","{\"ready\":false,")})A(!Repair.Ready(bad,123,"time","hash"));
  string root=Path.Combine(Path.GetTempPath(),"codecang-router-repair-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  string zip=Path.Combine(root,"helper.zip");using(var archive=ZipFile.Open(zip,ZipArchiveMode.Create)){using(var w=new StreamWriter(archive.CreateEntry("CodeCang.BootstrapWorker.exe").Open()))w.Write("non-executable fixture");}
  string hash;using(var sha=SHA256.Create())using(var f=File.OpenRead(zip))hash=VerifiedLease.Hex(sha.ComputeHash(f));
  Block(()=>{using(var h=VerifiedLease.Open(zip,new string('0',64))){};});
  using(var h=VerifiedLease.Open(zip,hash))using(var extracted=FreshLease.Extract(h,Path.Combine(root,"extracted"),"CodeCang.BootstrapWorker.exe")){A(File.ReadAllText(extracted.Installer)=="non-executable fixture");Block(()=>File.WriteAllText(extracted.Installer,"changed"));}
  if(args.Length==2){using(var held=VerifiedLease.Open(args[0],args[1]))using(var helper=FreshLease.Extract(held,Path.Combine(root,"real-helper"),"CodeCang.BootstrapWorker.exe")){A(File.Exists(helper.Installer));Console.WriteLine("PASS real helper ZIP verified/extracted under leases: "+Directory.GetFiles(Path.Combine(root,"real-helper"),"*",SearchOption.AllDirectories).Length+" files; no helper executed");}}
  Console.WriteLine("PASS "+count+" readiness/hash/extraction checks. Fixture retained: "+root+"; no executable/install/registry action.");return 0;
 }
}
