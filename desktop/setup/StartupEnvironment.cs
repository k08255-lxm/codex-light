using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace CodexLight.Bootstrap {
 internal static class StartupEnvironment {
  internal static string? IntegrityIssue(uint level)=>level<0x2000?"当前安装程序处于 Windows 低完整性限制。请先将正式发行包解压到普通文件夹，再运行安装器。":null;
  public static string? ReadIntegrityIssue(){
   try{return IntegrityIssue(CodexLight.Runtime.ProcessIntegrity.ReadLevel());}
   catch(Win32Exception error){return "无法读取当前进程的 Windows 权限级别，安装已停止（"+error.NativeErrorCode+"）。请从普通文件夹重新运行正式发行的安装器。";}
  }

 }
}
