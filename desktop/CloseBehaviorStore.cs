using System.Text.Json;
namespace CodexLight.Desktop;
internal enum CloseBehavior { Ask, Tray, Exit }
internal sealed class CloseBehaviorStore(string path) {
 internal bool ReadFailed {get;private set;}
 internal static CloseBehaviorStore ForCurrentUser()=>new(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLight","close-behavior.json"));
 internal static string Name(CloseBehavior value)=>value switch {CloseBehavior.Tray=>"tray",CloseBehavior.Exit=>"exit",_=>"ask"};
 internal static CloseBehavior Parse(string? value)=>value switch {"ask"=>CloseBehavior.Ask,"tray"=>CloseBehavior.Tray,"exit"=>CloseBehavior.Exit,_=>throw new InvalidDataException("Invalid close behavior.")};
 static void NoLinks(string path){for(string? p=Path.GetFullPath(path);p!=null;p=Path.GetDirectoryName(p)){if((File.Exists(p)||Directory.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("Linked preference path.");}}
 internal CloseBehavior Load(){
  ReadFailed=false;
  try{NoLinks(path);using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Delete);if(stream.Length is <=0 or >1024)throw new InvalidDataException();using var doc=JsonDocument.Parse(stream);var value=doc.RootElement;if(value.ValueKind!=JsonValueKind.Object||value.EnumerateObject().Count()!=2||value.GetProperty("version").GetInt32()!=1)throw new InvalidDataException();return Parse(value.GetProperty("behavior").GetString());}
  catch(FileNotFoundException){return CloseBehavior.Ask;}catch(DirectoryNotFoundException){return CloseBehavior.Ask;}
  catch(Exception e) when(e is IOException or InvalidDataException or UnauthorizedAccessException or JsonException or InvalidOperationException or KeyNotFoundException or FormatException){ReadFailed=true;return CloseBehavior.Ask;}
 }
 internal bool Save(CloseBehavior behavior){
  if(!Enum.IsDefined(behavior))return false;string? temp=null;
  try{NoLinks(path);string dir=Path.GetDirectoryName(Path.GetFullPath(path))!;Directory.CreateDirectory(dir);NoLinks(path);temp=Path.Combine(dir,".close-"+Guid.NewGuid().ToString("N")+".tmp");using(var stream=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){JsonSerializer.Serialize(stream,new{version=1,behavior=Name(behavior)});stream.Flush(true);}NoLinks(path);File.Move(temp,path,true);temp=null;ReadFailed=false;return true;}
  catch(Exception e) when(e is IOException or UnauthorizedAccessException){return false;}
  finally{if(temp!=null){try{File.Delete(temp);}catch(IOException){}catch(UnauthorizedAccessException){}}}
 }
}

