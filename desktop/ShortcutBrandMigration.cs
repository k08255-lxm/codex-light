using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using Microsoft.Win32.SafeHandles;
namespace CodexLight.Desktop;

// Run only AFTER the native updater has exited (its updated hook runs before
// shortcut refresh). Old root stubs and pinned/custom links are never removed.
internal static class ShortcutBrandMigration {
 const string OldName="Codex Light", Brand="码舱 CodeCang", AppId="velopack.CodexLightDesktop";
 internal static IReadOnlyList<string> RunInstalled(string current) {
  var results=new List<string>();
  try {
   current=Path.GetFullPath(current).TrimEnd(Path.DirectorySeparatorChar);
   var root=Path.GetDirectoryName(current)!;
   var expected=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLightDesktop");
   if(!Same(root,expected)||Path.GetFileName(current)!="current"||File.Exists(Path.Combine(root,".portable")))return results;
   var doc=XDocument.Load(Path.Combine(current,"sq.version"));
   string Value(string name)=>doc.Descendants().First(x=>x.Name.LocalName==name).Value;
   if(Value("id")!="CodexLightDesktop"||Value("title")!=Brand||Value("mainExe")!="CodexLight.exe")return results;
   foreach(var dir in new[]{Environment.GetFolderPath(Environment.SpecialFolder.Programs),Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory)})
    if(!string.IsNullOrEmpty(dir))try{results.Add(Migrate(root,dir));}catch(Exception e){results.Add("Shortcut branding deferred: "+e.Message);}
  }catch(Exception e){results.Add("Shortcut branding deferred: "+e.Message);}
  return results;
 }
 internal static string Migrate(string root,string directory) {
  root=Path.GetFullPath(root);directory=Path.GetFullPath(directory);
  string old=Path.Combine(directory,OldName+".lnk"),target=Path.Combine(directory,Brand+".lnk"),oldExe=Path.Combine(root,OldName+".exe"),newExe=Path.Combine(root,Brand+".exe");
  if(!File.Exists(old))return "No legacy default shortcut";
  if(File.Exists(target))return "Existing branded shortcut preserved";
  if(!File.Exists(oldExe)||!File.Exists(newExe))return "Entrypoint missing; shortcut preserved";
  // Different volumes need a copy/delete protocol; refuse rather than weaken atomicity.
  if(!Same(Path.GetPathRoot(root)!,Path.GetPathRoot(directory)!))return "Cross-volume shortcut preserved";
  if(!LooksOwned(old,oldExe))return "Custom or unowned shortcut preserved";
  using var oldPin=new Pin(old, true);
  using var oldEntry=new Pin(oldExe,false);using var newEntry=new Pin(newExe,false);
  if(oldPin.Length>1024*1024)return "Oversized shortcut preserved";
  var backupDir=Path.Combine(root,"shortcut-backups");Directory.CreateDirectory(backupDir);
  using var backupPin=new Pin(backupDir,false,true);
  string id=Guid.NewGuid().ToString("N"),temp=Path.Combine(backupDir,".codecang-"+id+".tmp"),backup=Path.Combine(backupDir,id+".lnk");
  object obj=new ShellLink();
  try {
   var link=(IShellLinkW)obj;var persist=(IPersistStream)obj;
   persist.Load(new MemoryComStream(oldPin.Bytes()));
   var path=new StringBuilder(32768);link.GetPath(path,path.Capacity,IntPtr.Zero,4);
   var args=new StringBuilder(32768);link.GetArguments(args,args.Capacity);
   if(!Same(path.ToString(),oldExe)||args.Length!=0||GetAppId(obj)!=AppId)return "Custom or unowned shortcut preserved";
   link.SetPath(newExe);
   var icon=new StringBuilder(32768);link.GetIconLocation(icon,icon.Capacity,out int iconIndex);
   if(Same(icon.ToString(),oldExe))link.SetIconLocation(newExe,iconIndex);
   // COM never receives a writable filesystem path: serialize into memory.
   var serialized=new MemoryComStream();persist.Save(serialized,false);
   var expectedBytes=serialized.Bytes();
   object check=new ShellLink();try{((IPersistStream)check).Load(new MemoryComStream(expectedBytes));var verify=new StringBuilder(32768);((IShellLinkW)check).GetPath(verify,verify.Capacity,IntPtr.Zero,4);if(!Same(verify.ToString(),newExe)||GetAppId(check)!=AppId)throw new IOException("Prepared shortcut verification failed");}finally{Marshal.FinalReleaseComObject(check);}
   using var prepared=new Pin(temp,true,create:true);
   prepared.Write(expectedBytes);
   if(!prepared.Bytes().SequenceEqual(expectedBytes))throw new IOException("Prepared shortcut changed");
   oldPin.Rename(backup);
   try {prepared.Rename(target);}catch {oldPin.Rename(old);throw;}
   SHChangeNotify(1,0x2005,old,target); // Rename + Unicode paths, asynchronous Shell cache refresh.
   return "Migrated default shortcut; original retained at "+backup;
  }finally {Marshal.FinalReleaseComObject(obj);/* Failed temporary copies are retained, never sweep arbitrary paths. */}
 }
 static bool LooksOwned(string file,string oldExe){object obj=new ShellLink();try{((IPersistFile)obj).Load(file,0);var link=(IShellLinkW)obj;var path=new StringBuilder(32768);var args=new StringBuilder(32768);link.GetPath(path,path.Capacity,IntPtr.Zero,4);link.GetArguments(args,args.Capacity);return Same(path.ToString(),oldExe)&&args.Length==0&&GetAppId(obj)==AppId;}finally{Marshal.FinalReleaseComObject(obj);}}
 static bool Same(string a,string b)=>string.Equals(Path.GetFullPath(a).TrimEnd('\\'),Path.GetFullPath(b).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase);
 static string? GetAppId(object obj){var key=new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),5);((IPropertyStore)obj).GetValue(ref key,out var value);try{return value.Type switch{31=>Marshal.PtrToStringUni(value.Pointer),0x101f when value.Count==1&&value.VectorPointer!=IntPtr.Zero=>Marshal.PtrToStringUni(Marshal.ReadIntPtr(value.VectorPointer)),_=>null};}finally{PropVariantClear(ref value);}}
 internal static void SetAppIdForTest(object obj,string appId){var key=new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),5);var value=new PropVariant{Type=31,Pointer=Marshal.StringToCoTaskMemUni(appId)};try{((IPropertyStore)obj).SetValue(ref key,ref value);((IPropertyStore)obj).Commit();}finally{PropVariantClear(ref value);}}
 internal static void SetVectorAppIdForTest(object obj,params string[] ids){var key=new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),5);var value=new PropVariant{Type=0x101f,Count=(uint)ids.Length,VectorPointer=Marshal.AllocCoTaskMem(IntPtr.Size*ids.Length)};for(int i=0;i<ids.Length;i++)Marshal.WriteIntPtr(value.VectorPointer,i*IntPtr.Size,Marshal.StringToCoTaskMemUni(ids[i]));try{((IPropertyStore)obj).SetValue(ref key,ref value);((IPropertyStore)obj).Commit();}finally{PropVariantClear(ref value);}}
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern void SHChangeNotify(uint change,uint flags,[MarshalAs(UnmanagedType.LPWStr)]string before,[MarshalAs(UnmanagedType.LPWStr)]string after);
 [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant p);
 [StructLayout(LayoutKind.Sequential)] struct PropertyKey(Guid fmt,uint id){public Guid Format=fmt;public uint Id=id;}
 [StructLayout(LayoutKind.Explicit)] struct PropVariant{[FieldOffset(0)]public ushort Type;[FieldOffset(8)]public IntPtr Pointer;[FieldOffset(8)]public uint Count;[FieldOffset(16)]public IntPtr VectorPointer;}
 [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IPropertyStore{void GetCount(out uint n);void GetAt(uint n,out PropertyKey k);void GetValue(ref PropertyKey k,out PropVariant v);void SetValue(ref PropertyKey k,ref PropVariant v);void Commit();}
 [ComImport,Guid("00000109-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IPersistStream{
  void GetClassID(out Guid id);[PreserveSig]int IsDirty();void Load(IStream stream);void Save(IStream stream,[MarshalAs(UnmanagedType.Bool)]bool clearDirty);void GetSizeMax(out long size);
 }
 sealed class MemoryComStream:IStream{
  readonly MemoryStream stream;public MemoryComStream(){stream=new();}public MemoryComStream(byte[] bytes){stream=new(bytes,false);}public byte[] Bytes()=>stream.ToArray();
  public void Read(byte[] bytes,int count,IntPtr read){int n=stream.Read(bytes,0,count);if(read!=IntPtr.Zero)Marshal.WriteInt32(read,n);}
  public void Write(byte[] bytes,int count,IntPtr written){stream.Write(bytes,0,count);if(written!=IntPtr.Zero)Marshal.WriteInt32(written,count);}
  public void Seek(long move,int origin,IntPtr position){long n=stream.Seek(move,(SeekOrigin)origin);if(position!=IntPtr.Zero)Marshal.WriteInt64(position,n);}
  public void SetSize(long size)=>stream.SetLength(size);
  public void CopyTo(IStream dest,long count,IntPtr read,IntPtr written){var buffer=new byte[8192];long total=0;while(total<count){int n=stream.Read(buffer,0,(int)Math.Min(buffer.Length,count-total));if(n==0)break;dest.Write(buffer,n,IntPtr.Zero);total+=n;}if(read!=IntPtr.Zero)Marshal.WriteInt64(read,total);if(written!=IntPtr.Zero)Marshal.WriteInt64(written,total);}
  public void Commit(int flags){}public void Revert()=>throw new NotSupportedException();public void LockRegion(long offset,long count,int type)=>throw new NotSupportedException();public void UnlockRegion(long offset,long count,int type)=>throw new NotSupportedException();
  public void Stat(out STATSTG stat,int flags){stat=new STATSTG{type=2,cbSize=stream.Length,grfMode=2};}public void Clone(out IStream copy){copy=new MemoryComStream(stream.ToArray());copy.Seek(stream.Position,0,IntPtr.Zero);}
 }
 [ComImport,Guid("00021401-0000-0000-C000-000000000046")] internal class ShellLink{}
 [ComImport,Guid("000214F9-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] internal interface IShellLinkW{
  void GetPath([Out,MarshalAs(UnmanagedType.LPWStr)]StringBuilder path,int count,IntPtr data,uint flags);void GetIDList(out IntPtr p);void SetIDList(IntPtr p);void GetDescription([Out,MarshalAs(UnmanagedType.LPWStr)]StringBuilder s,int n);void SetDescription([MarshalAs(UnmanagedType.LPWStr)]string s);void GetWorkingDirectory([Out,MarshalAs(UnmanagedType.LPWStr)]StringBuilder s,int n);void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)]string s);void GetArguments([Out,MarshalAs(UnmanagedType.LPWStr)]StringBuilder s,int n);void SetArguments([MarshalAs(UnmanagedType.LPWStr)]string s);void GetHotkey(out short n);void SetHotkey(short n);void GetShowCmd(out int n);void SetShowCmd(int n);void GetIconLocation([Out,MarshalAs(UnmanagedType.LPWStr)]StringBuilder s,int n,out int index);void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)]string s,int index);void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)]string s,uint n);void Resolve(IntPtr h,uint flags);void SetPath([MarshalAs(UnmanagedType.LPWStr)]string s);
 }
 // Pin all ancestors against reparse/swap and the exact leaf against mutation.
 internal sealed class Pin:IDisposable{
  readonly List<SafeFileHandle> parents=[];readonly SafeFileHandle handle;readonly FileStream? stream;
  public long Length=>stream!.Length;
  public void CopyTo(Stream output){stream!.Position=0;stream.CopyTo(output);}
  public void Write(byte[] bytes){stream!.Write(bytes);stream.Flush(true);}
  public byte[] Bytes(){using var output=new MemoryStream();CopyTo(output);return output.ToArray();}
  public Pin(string path,bool rename,bool directory=false,bool create=false){
   var dirs=new Stack<string>();for(string? p=Path.GetDirectoryName(path);p!=null;p=Path.GetDirectoryName(p))dirs.Push(p);
   try{while(dirs.Count>0)parents.Add(Open(dirs.Pop(),0x80,true));handle=Open(path,(directory?0x80u:0x80000000u)|(rename?0x10000u:0)|(create?0x40000000u:0),directory,create);if(!directory)stream=new FileStream(handle,create?FileAccess.ReadWrite:FileAccess.Read);}catch{foreach(var h in parents)h.Dispose();throw;}
  }
  static SafeFileHandle Open(string path,uint access,bool directory,bool create=false){var h=CreateFile(@"\\?\"+Path.GetFullPath(path),access,1,IntPtr.Zero,create?1u:3u,0x02200000,IntPtr.Zero);if(h.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());if(!GetFileInformationByHandle(h,out var i)||(i.Attributes&0x400)!=0||((i.Attributes&0x10)!=0)!=directory||(!directory&&i.Links!=1)){h.Dispose();throw new IOException("Untrusted shortcut path");}return h;}
  public void Rename(string target){byte[] name=Encoding.Unicode.GetBytes(@"\\?\"+target);int off=(int)Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.Name));int size=off+name.Length+2;IntPtr p=Marshal.AllocHGlobal(size);try{for(int n=0;n<size;n++)Marshal.WriteByte(p,n,0);Marshal.WriteInt32(p,(int)Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.Length)),name.Length);Marshal.Copy(name,0,IntPtr.Add(p,off),name.Length);if(!SetFileInformationByHandle(handle,3,p,(uint)size))throw new Win32Exception(Marshal.GetLastWin32Error());}finally{Marshal.FreeHGlobal(p);}}
  public void Dispose(){stream?.Dispose();handle.Dispose();foreach(var p in parents)p.Dispose();}
 }
 [StructLayout(LayoutKind.Sequential)] struct RenameInfo{public uint Flags;public IntPtr Root;public uint Length;public char Name;}
 [StructLayout(LayoutKind.Sequential)] struct FileInfo{public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(SafeFileHandle h,out FileInfo info);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetFileInformationByHandle(SafeFileHandle h,int kind,IntPtr data,uint size);
}
