using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Runtime.Serialization;
using System.Threading;
using CodexLight.Runtime;
namespace CodexLight.Bootstrap {
 [DataContract]internal sealed class LockedDependency {[DataMember(Name="url")]public string Url="";[DataMember(Name="hash")]public string Hash="";[DataMember(Name="algorithm")]public string Algorithm="";}
 [DataContract]internal sealed class DependencyLock {[DataMember(Name="dotnet")]public LockedDependency Dotnet=new LockedDependency();[DataMember(Name="node")]public LockedDependency Node=new LockedDependency();[DataMember(Name="webview")]public LockedDependency Webview=new LockedDependency();}
}
namespace CodexLight.Prerequisites {
 internal static class Program {
  static bool IsX64(string file){
   using(var r=new BinaryReader(File.OpenRead(file))){if(r.BaseStream.Length<64||r.ReadUInt16()!=0x5a4d)return false;r.BaseStream.Position=60;int offset=r.ReadInt32();if(offset<64||offset>r.BaseStream.Length-6)return false;r.BaseStream.Position=offset;return r.ReadUInt32()==0x4550&&r.ReadUInt16()==0x8664;}
  }
  static NodeRuntimeInfo? Detect(string directory,out bool uncertain){
   uncertain=false;var bundled=Path.GetFullPath(Path.Combine(directory,"runtime","node.exe"));var diagnostics=new List<string>();
   var candidates=NodeRuntimeDetection.CandidatePaths(directory,diagnostics).OrderBy(x=>string.Equals(x,bundled,StringComparison.OrdinalIgnoreCase)?1:0);
   foreach(var candidate in candidates){
    if(!File.Exists(candidate))continue;
    try{if(!IsX64(candidate)){Console.Error.WriteLine("Skipping non-x64 Node: "+candidate);continue;}
     var runtime=NodeRuntimeDetection.Probe(candidate,out string failure);if(runtime!=null){Console.WriteLine("COMPATIBLE\t"+runtime.Version+"\tx64\t"+runtime.Path);return runtime;}
     Console.Error.WriteLine(candidate+": "+failure);uncertain=true;
    }catch(Exception e)when(e is IOException||e is UnauthorizedAccessException){Console.Error.WriteLine(e.Message);uncertain=true;}
   }
   if(diagnostics.Count>0){uncertain=true;Console.Error.WriteLine(string.Join(Environment.NewLine,diagnostics));}return null;
  }
  static int Main(string[] args){
   try{
    if(args.Length==1&&args[0]=="--self-test")return SelfTest();
    if(args.Length!=2||(args[0]!="--check-node"&&args[0]!="--install-node")||!Path.IsPathRooted(args[1])||!Directory.Exists(args[1])){Console.Error.WriteLine("Usage: --check-node|--install-node ABSOLUTE_APPLICATION_DIRECTORY. Install requires user consent; check is default workflow. Exit 0 ready, 20 missing, 21 uncertain/error, 3010 reboot, 1602 cancelled.");return 21;}
    if(Detect(args[1],out bool uncertain)!=null)return 0;
    if(uncertain){Console.Error.WriteLine("Node detection uncertain: no automatic installation. Repair or select the installed runtime first.");return 21;}
    if(args[0]=="--check-node"){Console.WriteLine("MISSING: install official Node.js x64 20+ or explicitly run --install-node after consent.");return 20;}
    int result=CodexLight.Bootstrap.DependencyInstaller.Install("node",Console.Error.WriteLine,CancellationToken.None,_=>{},false).GetAwaiter().GetResult();
    if(result==3010||result==1641){Console.WriteLine("REBOOT_REQUIRED: setup must not proceed.");return 3010;}
    return Detect(args[1],out uncertain)!=null?0:21;
   }catch(OperationCanceledException){return 1602;}catch(Exception e){Console.Error.WriteLine(e.Message);return 21;}
  }
  static int SelfTest(){
   string root=Path.Combine(Path.GetTempPath(),"CodexLight-NodeProbe-Test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
   try{string file=Path.Combine(root,"fixture.bin");File.WriteAllBytes(file,new byte[2]);if(IsX64(file))throw new Exception("short PE accepted");
    using(var w=new BinaryWriter(File.Create(file))){w.Write(new byte[128]);w.BaseStream.Position=0;w.Write((ushort)0x5a4d);w.BaseStream.Position=60;w.Write(64);w.BaseStream.Position=64;w.Write(0x4550u);w.Write((ushort)0x8664);}
    if(!IsX64(file))throw new Exception("x64 PE rejected");using(var w=new BinaryWriter(File.OpenWrite(file))){w.BaseStream.Position=68;w.Write((ushort)0x14c);}if(IsX64(file))throw new Exception("x86 PE accepted");
    Console.WriteLine("PASS: truncated, x64, x86 PE detection; no runtime or installer executed.");return 0;
   }finally{File.Delete(Path.Combine(root,"fixture.bin"));Directory.Delete(root);}
  }
 }
}
