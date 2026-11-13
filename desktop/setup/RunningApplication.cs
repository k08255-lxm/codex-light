using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace CodexLight.Bootstrap {
 internal sealed class RunningAppProcess {
  internal int Id { get; }
  internal long Created { get; }
  internal string Executable { get; }
  internal int Session { get; }
  internal RunningAppProcess(int id, long created, string executable, int session) { Id = id; Created = created; Executable = executable; Session = session; }
  internal bool SameProcess(RunningAppProcess other) => Id == other.Id && Created == other.Created;
 }

 internal interface IRunningApplicationSystem {
  string CanonicalPath(string path);
  IReadOnlyList<RunningAppProcess> FindCandidates();
  Task RequestShutdownAsync(IReadOnlyList<RunningAppProcess> processes, CancellationToken token);
  Task Delay(CancellationToken token);
  int CurrentSession { get; }
 }

 internal static class RunningApplication {
  internal const string StillRunning = "Codex Light 尚未退出。请从托盘菜单选择“退出”，然后点击“重试”。安装器不会强制结束应用。";
  internal static Task PrepareAsync(string target, Func<IReadOnlyList<RunningAppProcess>, CancellationToken, Task<bool>> confirm, CancellationToken token) => PrepareAsync(target, confirm, token, new WindowsRunningApplicationSystem());
  internal static void EnsureStopped(string target) => EnsureStopped(target, new WindowsRunningApplicationSystem());
  internal static void EnsureStopped(string target, IRunningApplicationSystem system) {
   if (FindMatches(target, system).Count != 0) throw new InvalidOperationException(StillRunning);
  }
  static IReadOnlyList<RunningAppProcess> FindMatches(string target, IRunningApplicationSystem system) {
   string expected = system.CanonicalPath(Path.Combine(target, "CodexLight.exe"));
   return system.FindCandidates().Where(process => string.Equals(expected, system.CanonicalPath(process.Executable), StringComparison.OrdinalIgnoreCase)).ToArray();
  }
  internal static async Task PrepareAsync(string target, Func<IReadOnlyList<RunningAppProcess>, CancellationToken, Task<bool>> confirm, CancellationToken token, IRunningApplicationSystem system, int waitAttempts = 60) {
   token.ThrowIfCancellationRequested();
   var found = await Task.Run(() => FindMatches(target, system), token);
   if (found.Count == 0) return;
   if (found.Any(process => process.Session != system.CurrentSession)) throw new InvalidOperationException("其他 Windows 会话中仍有此安装位置的 Codex Light。请先在对应会话退出应用，再点击“重试”。");
   if (!await confirm(found, token)) throw new OperationCanceledException("已取消安装，未请求关闭 Codex Light。", token);
   token.ThrowIfCancellationRequested();
   var current = await Task.Run(() => FindMatches(target, system), token);
   // Consent belongs to these process instances, not a PID that Windows may reuse.
   if (current.Any(process => !found.Any(original => original.SameProcess(process)))) throw new InvalidOperationException("检测到新启动的 Codex Light。请点击“重试”，重新确认关闭应用。");
   if (current.Count == 0) return;
   await system.RequestShutdownAsync(current, token);
   for (int attempt = 0; attempt <= waitAttempts; attempt++) {
    token.ThrowIfCancellationRequested();
    if ((await Task.Run(() => FindMatches(target, system), token)).Count == 0) return;
    if (attempt < waitAttempts) await system.Delay(token);
   }
   throw new InvalidOperationException(StillRunning);
  }
 }

 internal sealed class WindowsRunningApplicationSystem : IRunningApplicationSystem {
  public int CurrentSession { get { using (var process = Process.GetCurrentProcess()) return process.SessionId; } }
  public Task Delay(CancellationToken token) => Task.Delay(250, token);
  public string CanonicalPath(string path) {
   string full = Path.GetFullPath(path);
   using (var file = CreateFile(full, 0, 7, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
    if (file.IsInvalid) {
     int error = Marshal.GetLastWin32Error();
     if (error == 2 || error == 3) return full;
     throw IdentityError(error);
    }
    var buffer = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandle(file, buffer, (uint)buffer.Capacity, 0);
    if (length == 0) throw IdentityError(Marshal.GetLastWin32Error());
    if (length >= buffer.Capacity) throw new InvalidOperationException("无法核对 Codex Light 的实际安装路径：路径过长。");
    string resolved = buffer.ToString();
    if (resolved.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + resolved.Substring(8);
    return resolved.StartsWith(@"\\?\", StringComparison.Ordinal) ? resolved.Substring(4) : resolved;
   }
  }
  public IReadOnlyList<RunningAppProcess> FindCandidates() {
   var matches = new List<RunningAppProcess>();
   foreach (var process in Process.GetProcessesByName("CodexLight")) {
    using (process) {
     // QUERY_LIMITED_INFORMATION reads identity without requesting termination rights.
     using (var handle = OpenProcess(0x1000, false, process.Id)) {
      if (handle.IsInvalid) {
       int error = Marshal.GetLastWin32Error();
       if (error == 87) continue; // The process exited between enumeration and OpenProcess.
       throw IdentityError(error);
      }
      var path = new StringBuilder(32768); int size = path.Capacity;
      if (!QueryFullProcessImageName(handle, 0, path, ref size)) throw IdentityError(Marshal.GetLastWin32Error());
      long created, exited, kernel, user;
      if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw IdentityError(Marshal.GetLastWin32Error());
      uint session;
      if (!ProcessIdToSessionId((uint)process.Id, out session)) {
       int error = Marshal.GetLastWin32Error();
       if (error == 87) continue;
       throw IdentityError(error);
      }
      matches.Add(new RunningAppProcess(process.Id, created, path.ToString(), unchecked((int)session)));
     }
    }
   }
   return matches;
  }
  public Task RequestShutdownAsync(IReadOnlyList<RunningAppProcess> processes, CancellationToken token) => Task.Run(() => {
   token.ThrowIfCancellationRequested();
   uint session; var key = new StringBuilder(33);
   RequireSuccess(RmStartSession(out session, 0, key));
   try {
    var identities = processes.Select(process => new UniqueProcess { Id = (uint)process.Id, Created = process.Created }).ToArray();
    RequireSuccess(RmRegisterResources(session, 0, null, (uint)identities.Length, identities, 0, null));
    using (token.Register(() => RmCancelCurrentTask(session))) {
     token.ThrowIfCancellationRequested();
     // Zero flags asks Windows for graceful session-end shutdown; never RmForceShutdown.
     int result = RmShutdown(session, 0, IntPtr.Zero);
     token.ThrowIfCancellationRequested();
     RequireSuccess(result);
    }
   } finally { RmEndSession(session); }
  }, token);
  static InvalidOperationException IdentityError(int code) => new InvalidOperationException("无法核对正在运行的 Codex Light 的身份。请手动退出应用后重试。", new Win32Exception(code));
  static void RequireSuccess(int result) { if (result != 0) throw new InvalidOperationException("无法请求 Codex Light 正常退出。请从托盘菜单选择“退出”，然后点击“重试”。", new Win32Exception(result)); }
  // FILETIME has 4-byte alignment in RM_UNIQUE_PROCESS (12 bytes, including on x64).
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct UniqueProcess { public uint Id; public long Created; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int id);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder path, ref int size);
  [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetProcessTimes(SafeProcessHandle process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool ProcessIdToSessionId(uint process, out uint session);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFile(string path, uint access, uint sharing, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint session, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint fileCount, string[]? files, uint appCount, [In] UniqueProcess[] apps, uint serviceCount, string[]? services);
  [DllImport("rstrtmgr.dll")] static extern int RmShutdown(uint session, uint flags, IntPtr progress);
  [DllImport("rstrtmgr.dll")] static extern int RmCancelCurrentTask(uint session);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
 }
}
