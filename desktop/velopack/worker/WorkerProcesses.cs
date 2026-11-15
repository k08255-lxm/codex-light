using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace CodexLight.Desktop;
internal static class WorkerProcesses {
 const int MoreData=234;
 [StructLayout(LayoutKind.Sequential)] internal struct UniqueProcess { internal uint Pid; internal System.Runtime.InteropServices.ComTypes.FILETIME Started; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] internal struct ProcessInfo {
  internal UniqueProcess Process;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] internal string AppName;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] internal string ServiceName;
  internal uint AppType,Status,Session;
  [MarshalAs(UnmanagedType.Bool)] internal bool Restartable;
 }
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session,uint flags,StringBuilder key);
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint session,uint files,string[] names,uint applications,IntPtr processes,uint services,IntPtr namesOfServices);
 [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session,out uint needed,ref uint count,[In,Out] ProcessInfo[]? processes,out uint rebootReasons);
 [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
 // Query only resources being replaced. Enumerating every OS process makes an
 // unrelated protected service block all updates for a normal Windows user.
 // Never call RmShutdown/RmRestart: a real holder is reported, not terminated.
 internal static string[] InstalledResources(string root){
  root=WorkerPolicy.Canonical(root);WorkerPolicy.Plain(root);
  var current=Path.Combine(root,"current");WorkerPolicy.Plain(current);
  if(!Directory.Exists(current))throw new IOException("Installed current directory missing.");
  var files=new List<string>();var pending=new Stack<string>();pending.Push(current);
  while(pending.Count>0){var directory=pending.Pop();foreach(var entry in Directory.EnumerateFileSystemEntries(directory)){
   WorkerPolicy.Plain(entry);var attributes=File.GetAttributes(entry);
   if((attributes&FileAttributes.Directory)!=0)pending.Push(entry);else files.Add(Path.GetFullPath(entry));
   if(files.Count+pending.Count>20000)throw new IOException("Installed resource limit exceeded.");
  }}
  foreach(var file in Directory.EnumerateFiles(root,"*.exe",SearchOption.TopDirectoryOnly)){WorkerPolicy.Plain(file);files.Add(Path.GetFullPath(file));}
  if(files.Count==0||files.Count>20000)throw new IOException("Installed resources missing or excessive.");
  return files.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
 }
 internal static uint[] Holders(string[] files){
  if(files.Length==0)throw new ArgumentException("No update resources.");
  int code=RmStartSession(out var session,0,new StringBuilder(33));
  if(code!=0)throw new Win32Exception(code,"Cannot start installed-file occupancy check");
  try{
   foreach(var batch in files.Chunk(256)){code=RmRegisterResources(session,(uint)batch.Length,batch,0,IntPtr.Zero,0,IntPtr.Zero);if(code!=0)throw new Win32Exception(code,"Cannot register installed files for occupancy check");}
   ProcessInfo[]? items=null;
   for(int attempt=0;attempt<5;attempt++){
    uint count=(uint)(items?.Length??0);code=RmGetList(session,out var needed,ref count,items,out var reboot);
    if(code==0){if(reboot!=0)throw new IOException("Installed resources require a restart before updating.");return items==null?Array.Empty<uint>():items.Take((int)count).Select(p=>p.Process.Pid).Distinct().ToArray();}
    if(code!=MoreData)throw new Win32Exception(code,"Cannot determine installed-file occupancy");
    if(needed==0||needed>20000)throw new IOException("Invalid installed-file occupancy result.");
    items=new ProcessInfo[needed];
   }
   throw new IOException("Installed-file occupancy changed repeatedly; retry after closing the application.");
  }finally{RmEndSession(session);}
 }
 internal static void CheckHolders(IEnumerable<uint> pids){var holders=pids.Distinct().ToArray();if(holders.Length!=0)throw new InvalidOperationException("Installed files still in use by PID(s): "+string.Join(", ",holders)+". Save work and close these applications before updating.");}
 internal static void EnsureNoInstalledProcesses(string root){CheckHolders(Holders(InstalledResources(root)));}
}
