using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
namespace CodexLight.Prerequisites {
 public static class SafeTar {
  public static long Extract(Stream compressed,string destination,long maximumBytes,int maximumFiles,CancellationToken token){
   using(var gzip=new GZipStream(compressed,CompressionMode.Decompress,true)){
    var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);long total=0;int files=0,entries=0;var header=new byte[512];
    while(true){Read(gzip,header,512,token);bool zero=true;foreach(byte b in header)if(b!=0){zero=false;break;}if(zero)return total;
     long expected=Octal(header,148,8),checksum=0;for(int i=0;i<512;i++)checksum+=i>=148&&i<156?32:header[i];if(checksum!=expected)throw new InvalidDataException("Tar checksum invalid");
     string name=Text(header,0,100),prefix=Text(header,345,155);if(prefix.Length>0)name=prefix+"/"+name;
     long size=Octal(header,124,12);byte type=header[156];if(type!=0&&type!=(byte)'0'&&type!=(byte)'5')throw new InvalidDataException("Tar links/extended entries refused");
     if(type==(byte)'5'){if(size!=0)throw new InvalidDataException();name=name.TrimEnd('/');}
     ValidateName(name);if(++entries>maximumFiles*4)throw new InvalidDataException("Archive entry count exceeds budget");if(!names.Add(name))throw new InvalidDataException("Duplicate archive entry");
     string target=Path.GetFullPath(Path.Combine(destination,name.Replace('/',Path.DirectorySeparatorChar)));
     string root=Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
     if(!target.StartsWith(root,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Archive path escape");
     CliPrerequisite.CheckedDirectory(Path.GetDirectoryName(target)!);
     if(type==(byte)'5'){CliPrerequisite.CheckedDirectory(target);continue;}
     if(++files>maximumFiles||size<0||size>maximumBytes-total)throw new InvalidDataException("Archive exceeds budget");total+=size;
     using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None)){var block=new byte[65536];long remaining=size;while(remaining>0){int count=(int)Math.Min(block.Length,remaining);Read(gzip,block,count,token);output.Write(block,0,count);remaining-=count;}output.Flush(true);}
     int padding=(int)((512-size%512)%512);if(padding>0)Read(gzip,new byte[padding],padding,token);
    }
   }
  }
  public static void ValidateName(string name){
   if(!name.StartsWith("package/",StringComparison.Ordinal)&&name!="package")throw new InvalidDataException("Package prefix required");
   if(name.Length>240||name.IndexOf('\\')>=0||name.IndexOf(':')>=0||Path.IsPathRooted(name))throw new InvalidDataException("Unsafe archive name");
   foreach(string part in name.Split('/')){if(part.Length==0||part=="."||part==".."||part.EndsWith(".",StringComparison.Ordinal)||part.EndsWith(" ",StringComparison.Ordinal)||part.IndexOfAny(Path.GetInvalidFileNameChars())>=0||System.Text.RegularExpressions.Regex.IsMatch(part,@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)",System.Text.RegularExpressions.RegexOptions.IgnoreCase))throw new InvalidDataException("Unsafe archive component");}
  }
  static string Text(byte[] b,int offset,int count){int end=offset;while(end<offset+count&&b[end]!=0)end++;return new UTF8Encoding(false,true).GetString(b,offset,end-offset);}
  static long Octal(byte[] b,int offset,int count){string s=Encoding.ASCII.GetString(b,offset,count).Trim('\0',' ');if(s.Length==0)return 0;long value=0;foreach(char c in s){if(c<'0'||c>'7')throw new InvalidDataException("Invalid tar number");value=checked(value*8+c-'0');}return value;}
  static void Read(Stream s,byte[] b,int count,CancellationToken token){int n=0;while(n<count){token.ThrowIfCancellationRequested();int got=s.Read(b,n,count-n);if(got==0)throw new EndOfStreamException();n+=got;}}
 }
}
