using System;using System.IO;using System.Security.Cryptography;using System.Security.Principal;using System.Text;using System.Threading;
namespace CodexLight.Shared {
 internal sealed class InstallMaintenance:IDisposable {
  readonly Mutex mutex;bool owned;
  InstallMaintenance(Mutex mutex){this.mutex=mutex;owned=true;}
  public static string Key(string target,string sid){string normalized=Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar).ToUpperInvariant();using(var sha=SHA256.Create())return @"Local\CodexLight.Install."+BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(sid+"\n"+normalized))).Replace("-","");}
  // Acquire/release on one OS thread; callers must not carry this scope across await.
  public static InstallMaintenance Acquire(string target){for(string? current=Path.GetFullPath(target);!string.IsNullOrEmpty(current);current=Path.GetDirectoryName(current)){if((File.Exists(current)||Directory.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("安装目录不能通过链接或重解析路径启动维护");}string sid=WindowsIdentity.GetCurrent().User?.Value??throw new InvalidOperationException("无法识别当前 Windows 用户");var mutex=new Mutex(false,Key(target,sid));bool acquired;try{try{acquired=mutex.WaitOne(0);}catch(AbandonedMutexException){acquired=true;}if(!acquired)throw new InvalidOperationException("此安装的程序或维护任务正在运行，请先正常关闭；不会强制终止进程。");return new InstallMaintenance(mutex);}catch{mutex.Dispose();throw;}}
  public void Dispose(){if(owned){owned=false;mutex.ReleaseMutex();mutex.Dispose();}}
 }
}
