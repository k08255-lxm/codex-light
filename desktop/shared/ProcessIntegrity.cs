using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace CodexLight.Runtime {
 internal static class ProcessIntegrity {
  public static uint ReadLevel(){
   IntPtr token;if(!OpenProcessToken(GetCurrentProcess(),0x0008,out token))throw new Win32Exception(Marshal.GetLastWin32Error());
   try{
    int length;GetTokenInformation(token,25,IntPtr.Zero,0,out length);
    if(length<=0)throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr buffer=Marshal.AllocHGlobal(length);
    try{
     if(!GetTokenInformation(token,25,buffer,length,out length))throw new Win32Exception(Marshal.GetLastWin32Error());
     IntPtr sid=Marshal.ReadIntPtr(buffer);int count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
     if(count<1)throw new Win32Exception(1337);
     return unchecked((uint)Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1))));
    }finally{Marshal.FreeHGlobal(buffer);}
   }finally{CloseHandle(token);}
  }
  [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool GetTokenInformation(IntPtr token,int type,IntPtr data,int length,out int required);
  [DllImport("advapi32.dll")]static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")]static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
 }
}
