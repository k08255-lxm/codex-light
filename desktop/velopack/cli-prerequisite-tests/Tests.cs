using System;using System.IO;using System.IO.Compression;using System.Text;using System.Threading;using System.Security.Cryptography;using CodexLight.Prerequisites;
class Tests {
 static int count;static void Check(bool b){if(!b)throw new Exception("Assertion failed "+count);count++;}
 static void Reject(Action a){try{a();}catch{count++;return;}throw new Exception("Expected rejection");}
 static byte[] Archive(string name,byte type=48,long? size=null,bool duplicate=false,bool validChecksum=true){
  using var raw=new MemoryStream();var header=new byte[512];Encoding.ASCII.GetBytes(name).CopyTo(header,0);Encoding.ASCII.GetBytes(Convert.ToString(size??3,8).PadLeft(11,'0')+"\0").CopyTo(header,124);header[156]=type;for(int i=148;i<156;i++)header[i]=32;long sum=0;foreach(byte b in header)sum+=b;if(!validChecksum)sum++;Encoding.ASCII.GetBytes(Convert.ToString(sum,8).PadLeft(6,'0')+"\0 ").CopyTo(header,148);
  for(int n=0;n<(duplicate?2:1);n++){raw.Write(header);raw.Write(Encoding.ASCII.GetBytes("abc"));raw.Write(new byte[509]);}raw.Write(new byte[1024]);using var result=new MemoryStream();using(var gzip=new GZipStream(result,CompressionMode.Compress,true)){gzip.Write(raw.ToArray());}return result.ToArray();
 }
 static void Main(string[] args){
  string root=Path.Combine(Path.GetTempPath(),"codex-cli-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  try{
   Check(CliPrerequisite.Compatible("0.157.1"));Check(CliPrerequisite.Compatible("0.167.0-alpha.3.2"));Check(!CliPrerequisite.Compatible("garbage"));
   CliPrerequisite.VerifyDownload(CliPrerequisite.ArchiveBytes,Convert.FromBase64String(CliPrerequisite.Integrity.Substring(7)));count++;Reject(()=>CliPrerequisite.VerifyDownload(CliPrerequisite.ArchiveBytes-1,Convert.FromBase64String(CliPrerequisite.Integrity.Substring(7))));Reject(()=>CliPrerequisite.VerifyDownload(CliPrerequisite.ArchiveBytes,new byte[64]));
   foreach(string s in new[]{"../file","package/../file","package/C:/file","package/a\\b","package/CON.txt","package/file.","package//file","/package/a"})Reject(()=>SafeTar.ValidateName(s));
   SafeTar.ValidateName("package/vendor/bin/codex.exe");count++;
   string good=Path.Combine(root,"good");Directory.CreateDirectory(good);using(var stream=new MemoryStream(Archive("package/a")))Check(SafeTar.Extract(stream,good,3,1,CancellationToken.None)==3);Check(File.ReadAllText(Path.Combine(good,"package","a"))=="abc");
   int i=0;void Bad(byte[] bytes,long limit=10,int maxFiles=3){string folder=Path.Combine(root,"bad"+(i++));Directory.CreateDirectory(folder);Reject(()=>{using var input=new MemoryStream(bytes);SafeTar.Extract(input,folder,limit,maxFiles,CancellationToken.None);});}
   Bad(Archive("package/link",50));Bad(Archive("package/link",49));Bad(Archive("package/a",120));Bad(Archive("package/a",48,3,true));Bad(Archive("package/a",validChecksum:false));Bad(Archive("package/a",size:100),5);Bad(Archive("package/a"),10,0);Bad(Archive("package/../outside"));
   string cancelled=Path.Combine(root,"cancelled");Directory.CreateDirectory(cancelled);Reject(()=>{using var input=new MemoryStream(Archive("package/a"));SafeTar.Extract(input,cancelled,10,2,new CancellationToken(true));});
   if(args.Length==1){string actual=Path.Combine(root,"official");Directory.CreateDirectory(actual);using(var input=File.OpenRead(args[0]))Check(SafeTar.Extract(input,actual,CliPrerequisite.ExpandedBytes,64,CancellationToken.None)==CliPrerequisite.ExpandedBytes);string exe=Path.Combine(actual,CliPrerequisite.ExecutableRelative.Replace('/',Path.DirectorySeparatorChar));using var f=File.OpenRead(exe);Check(Convert.ToHexString(SHA256.HashData(f)).ToLowerInvariant()==CliPrerequisite.ExecutableSha256);Console.WriteLine("Official package extracted and verified, no executable launched.");}
   Console.WriteLine("PASS "+count+" checks");
  }finally{if(!root.StartsWith(Path.GetTempPath(),StringComparison.OrdinalIgnoreCase))throw new Exception();Directory.Delete(root,true);}
 }
}
