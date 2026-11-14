using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace CodexLight.Desktop;
internal static class WorkerProcesses {
 const uint QueryLimitedInformation=0x1000, Synchronize=0x00100000;
 const uint WaitObject0=0;
 [DllImport("kernel32.dll",SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool QueryFullProcessImageName(SafeProcessHandle process,uint flags,StringBuilder image,ref uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(SafeProcessHandle handle,uint milliseconds);
 // Never infer safety from owner/session/process name: an elevated or other-session
 // executable may still be running from the installation we are about to replace.
 internal static string? ImageOrExited(int pid){
  using var handle=OpenProcess(QueryLimitedInformation|Synchronize,false,pid);
  if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot inspect process "+pid);
  var image=new StringBuilder(32768);uint length=(uint)image.Capacity;
  if(QueryFullProcessImageName(handle,0,image,ref length))return image.ToString();
  var error=Marshal.GetLastWin32Error();
  if(WaitForSingleObject(handle,0)==WaitObject0)return null;
  throw new Win32Exception(error,"Cannot identify live process "+pid);
 }
 internal static void Check(IEnumerable<int> pids,int ownPid,string root,Func<int,string?> imageOrExited){
  foreach(var pid in pids){if(pid==ownPid||pid==0||pid==4)continue;var image=imageOrExited(pid);if(image==null)continue; if(string.IsNullOrWhiteSpace(image))throw new InvalidOperationException("Empty executable path for process "+pid);if(WorkerPolicy.Within(image,root))throw new InvalidOperationException("Installed process still running: PID "+pid);}
 }
 internal static void EnsureNoInstalledProcesses(string root){var processes=Process.GetProcesses();try{Check(processes.Select(p=>p.Id),Environment.ProcessId,root,ImageOrExited);}finally{foreach(var p in processes)p.Dispose();}}
}
