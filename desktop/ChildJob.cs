using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace CodexLight.Desktop;
// Private job only; does not change system settings or terminate unrelated processes.
internal sealed class ChildJob : IDisposable {
 readonly SafeFileHandle handle;
 public ChildJob(){
  handle=CreateJobObject(IntPtr.Zero,null);if(handle.IsInvalid)throw new Win32Exception();
  var info=new ExtendedLimit();info.BasicLimitInformation.LimitFlags=0x2000; // KILL_ON_JOB_CLOSE
  int size=Marshal.SizeOf<ExtendedLimit>();var pointer=Marshal.AllocHGlobal(size);
  try {Marshal.StructureToPtr(info,pointer,false);if(!SetInformationJobObject(handle,9,pointer,(uint)size))throw new Win32Exception();}
  catch{handle.Dispose();throw;}finally{Marshal.FreeHGlobal(pointer);}
 }
 public void Assign(System.Diagnostics.Process process){if(!AssignProcessToJobObject(handle,process.Handle))throw new Win32Exception();}
 // A backend exit does not prove its descendants have left this kill-on-close job.
 // Query failure is deliberately not an empty job.
 public bool IsEmpty {
  get {
   if(handle.IsClosed||handle.IsInvalid)return false;
   return QueryInformationJobObject(handle,1,out var info,(uint)Marshal.SizeOf<Accounting>(),IntPtr.Zero)&&info.ActiveProcesses==0;
  }
 }
 public void Dispose()=>handle.Dispose();
 [StructLayout(LayoutKind.Sequential)] struct Accounting {public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime;public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses;}
 [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool QueryInformationJobObject(SafeFileHandle job,int infoClass,out Accounting info,uint size,IntPtr returnedLength);
 [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long PerProcessUserTimeLimit,PerJobUserTimeLimit;public uint LimitFlags;public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize;public uint ActiveProcessLimit;public UIntPtr Affinity;public uint PriorityClass,SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters{public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount;}
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit{public BasicLimit BasicLimitInformation;public IoCounters IoInfo;public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateJobObject(IntPtr attributes,string? name);
 [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool SetInformationJobObject(SafeFileHandle job,int infoClass,IntPtr info,uint length);
 [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool AssignProcessToJobObject(SafeFileHandle job,IntPtr process);
}
