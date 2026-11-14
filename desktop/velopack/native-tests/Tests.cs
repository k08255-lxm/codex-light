using System.IO.Compression;
using System.Security.Cryptography;
using CodexLight.Desktop;
var root=Path.Combine(Path.GetTempPath(),"codexlight-native-validation-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
var local=Path.Combine(root,"local");Directory.CreateDirectory(local);
string Metadata(string version,string id="CodexLightDesktop",string exe="CodexLight.exe")=>$"<package xmlns=\"http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd\"><metadata><id>{id}</id><version>{version}</version><mainExe>{exe}</mainExe><os>win</os><rid>win-x64</rid><channel>win</channel></metadata></package>";
var current=Path.Combine(root,"program","current");Directory.CreateDirectory(current);File.WriteAllText(Path.Combine(root,"program","Update.exe"),"fixture");File.WriteAllText(Path.Combine(current,"CodexLight.exe"),"fixture");File.WriteAllText(Path.Combine(current,"sq.version"),Metadata("0.4.3"));
var installed=VelopackPackage.ReadInstalled(current,local);int checks=0;
void Check(bool ok,string name){checks++;if(!ok)throw new Exception(name);}
void Reject(Action run,string name){try{run();}catch{checks++;return;}throw new Exception("Accepted: "+name);}
(string file,string hash) Package(string version="0.4.4",string id="CodexLightDesktop",string extra="",bool duplicate=false,bool link=false){
 var tmp=Path.Combine(root,Guid.NewGuid()+".zip");using(var f=File.Create(tmp))using(var z=new ZipArchive(f,ZipArchiveMode.Create)){
  void Add(string n,string data){var e=z.CreateEntry(n);using var w=new StreamWriter(e.Open());w.Write(data);}
  Add("CodexLightDesktop.nuspec",Metadata(version,id));Add("lib/app/sq.version",Metadata(version,id));
  Add("lib/app/CodexLight.exe","fixture");Add("lib/app/CodexLight.dll","fixture");Add("lib/app/app/src/desktop-backend.mjs","fixture");
  if(extra!="")Add(extra,"unsafe");if(duplicate)Add("LIB/APP/CodexLight.exe","duplicate");if(link){var e=z.CreateEntry("lib/app/link");e.ExternalAttributes=unchecked((int)0xA1FF0000);}
 }
 var hash=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(tmp))).ToLowerInvariant();var dir=Path.Combine(local,"CodexLight","Updates",version+"-"+hash[..16]);Directory.CreateDirectory(dir);var file=Path.Combine(dir,"CodexLightDesktop-"+version+"-full.nupkg");File.Move(tmp,file,true);return(file,hash);
}
var good=Package();using(var valid=VelopackPackage.Validate(good.file,good.hash,installed)){Check(valid.Version=="0.4.4","valid version");Reject(()=>File.Open(good.file,FileMode.Open,FileAccess.Write).Dispose(),"held read lease blocks writes");}
Reject(()=>VelopackPackage.ReadInstalled(Path.Combine(root,"program"),local),"requires current");
var overlap=Path.Combine(local,"CodexLight","current");Directory.CreateDirectory(overlap);Reject(()=>VelopackPackage.ReadInstalled(overlap,local),"data overlap");
foreach(var unsafePath in new[]{"../escape","lib/app/../escape","lib\\escape","/absolute","C:/drive","lib/app/CON.txt","lib/app/foo. ","lib/app/a:b","lib/app/app/src/desktop-backend.mjs/child"}){var p=Package(extra:unsafePath);Reject(()=>VelopackPackage.Validate(p.file,p.hash,installed).Dispose(),"unsafe path "+unsafePath);}
foreach(var version in new[]{"0.4.3","0.4.2"}){var p=Package(version);Reject(()=>VelopackPackage.Validate(p.file,p.hash,installed).Dispose(),"not newer");}
var wrong=Package(id:"OtherApp");Reject(()=>VelopackPackage.Validate(wrong.file,wrong.hash,installed).Dispose(),"wrong identity");
var dup=Package(duplicate:true);Reject(()=>VelopackPackage.Validate(dup.file,dup.hash,installed).Dispose(),"case duplicate");
var symlink=Package(link:true);Reject(()=>VelopackPackage.Validate(symlink.file,symlink.hash,installed).Dispose(),"zip symlink");
Reject(()=>VelopackPackage.Validate(good.file,new string('a',64),installed).Dispose(),"hash path mismatch");
var outside=Path.Combine(root,"CodexLightDesktop-0.4.4-full.nupkg");File.Copy(good.file,outside);Reject(()=>VelopackPackage.Validate(outside,good.hash,installed).Dispose(),"outside cache");
Reject(()=>VelopackPackage.Validate(good.file,good.hash,installed with {ProgramRoot=root}).Dispose(),"forged identity record");
File.WriteAllText(Path.Combine(current,"sq.version"),Metadata("0.4.4"));Reject(()=>VelopackPackage.Validate(good.file,good.hash,installed).Dispose(),"identity changed");
File.WriteAllText(Path.Combine(current,"sq.version"),Metadata("0.4.3").Replace("<version>0.4.3</version>","<version>0.4.3</version><version>0.4.3</version>"));Reject(()=>VelopackPackage.ReadInstalled(current,local),"duplicate installed version");
File.WriteAllText(Path.Combine(current,"sq.version"),"<!DOCTYPE x [<!ENTITY y SYSTEM 'file:///not-read'>]><x>&y;</x>");Reject(()=>VelopackPackage.ReadInstalled(current,local),"DTD forbidden");
Reject(()=>VelopackPackage.ReadInstalled(@"\\server\share\current",local),"UNC forbidden");
Console.WriteLine($"PASS {checks} native identity/package validation checks. Fixtures only: {root}");
