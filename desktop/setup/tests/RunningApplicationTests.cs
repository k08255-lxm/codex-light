using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using CodexLight.Bootstrap;

// All process enumeration, shutdown and waiting in these tests is fake.
internal static class RunningApplicationTests {
 const string Target = @"C:\Apps\CodexLight";
 static readonly RunningAppProcess Original = new RunningAppProcess(123, 456, Target + @"\CodexLight.exe", 7);
 static readonly RunningAppProcess Other = new RunningAppProcess(124, 789, @"C:\Other\CodexLight.exe", 7);
 sealed class FakeSystem : IRunningApplicationSystem {
  internal Func<int, IReadOnlyList<RunningAppProcess>> Scan = _ => Array.Empty<RunningAppProcess>();
  internal Action? Shutdown;
  internal int Scans, Requests, Delays;
  internal IReadOnlyList<RunningAppProcess> Requested = Array.Empty<RunningAppProcess>();
  public int CurrentSession => 7;
  public string CanonicalPath(string path) => Path.GetFullPath(path);
  public IReadOnlyList<RunningAppProcess> FindCandidates() => Scan(++Scans);
  public Task RequestShutdownAsync(IReadOnlyList<RunningAppProcess> processes, CancellationToken token) { token.ThrowIfCancellationRequested(); Requests++; Requested = processes; Shutdown?.Invoke(); return Task.CompletedTask; }
  public Task Delay(CancellationToken token) { token.ThrowIfCancellationRequested(); Delays++; return Task.CompletedTask; }
 }
 internal static int Run() {
  int checks = 0;
  void Assert(bool condition, string message) { checks++; if (!condition) throw new InvalidOperationException("Running application: " + message); }
  void Reject<T>(Action action, string message) where T : Exception {
   try { action(); } catch (T) { checks++; return; }
   throw new InvalidOperationException("Running application: " + message);
  }
  Task<bool> Accept(IReadOnlyList<RunningAppProcess> processes, CancellationToken token) => Task.FromResult(true);
  void Prepare(FakeSystem system, Func<IReadOnlyList<RunningAppProcess>, CancellationToken, Task<bool>>? confirm = null, CancellationToken token = default) => RunningApplication.PrepareAsync(Target, confirm ?? Accept, token, system, 2).GetAwaiter().GetResult();

  int confirmations = 0;
  var empty = new FakeSystem();
  Prepare(empty, (processes, token) => { confirmations++; return Task.FromResult(true); });
  Assert(confirmations == 0 && empty.Requests == 0, "empty discovery never asks consent or shutdown");

  var sibling = new FakeSystem { Scan = _ => new[] { Other, new RunningAppProcess(125, 999, Target + @"-backup\CodexLight.exe", 7) } };
  Prepare(sibling, (processes, token) => { confirmations++; return Task.FromResult(true); });
  Assert(confirmations == 0 && sibling.Requests == 0, "same executable name and folder prefix are insufficient");

  var declined = new FakeSystem { Scan = _ => new[] { Original } };
  Reject<OperationCanceledException>(() => Prepare(declined, (processes, token) => { confirmations++; return Task.FromResult(false); }), "declining must cancel installation");
  Assert(confirmations == 1 && declined.Requests == 0, "decline never reaches Restart Manager");

  var matched = new FakeSystem { Scan = n => n <= 2 ? new[] { Original, Other } : new[] { Other } };
  Prepare(matched, (processes, token) => { Assert(processes.Count == 1 && processes[0].Id == Original.Id, "confirmation identifies only the exact installed image"); return Task.FromResult(true); });
  Assert(matched.Requests == 1 && matched.Requested.Count == 1 && matched.Requested[0].SameProcess(Original), "shutdown receives only the confirmed PID and creation time");

  var alreadyExited = new FakeSystem { Scan = n => n == 1 ? new[] { Original } : Array.Empty<RunningAppProcess>() };
  Prepare(alreadyExited);
  Assert(alreadyExited.Requests == 0, "process exiting during confirmation needs no shutdown");

  var reused = new RunningAppProcess(Original.Id, Original.Created + 1, Original.Executable, Original.Session);
  var reuse = new FakeSystem { Scan = n => n == 1 ? new[] { Original } : new[] { reused } };
  Reject<InvalidOperationException>(() => Prepare(reuse), "PID reuse requires new confirmation");
  Assert(reuse.Requests == 0, "reused PID never receives the original consent");

  var newInstance = new FakeSystem { Scan = n => n == 1 ? new[] { Original } : new[] { Original, new RunningAppProcess(999, 888, Original.Executable, 7) } };
  Reject<InvalidOperationException>(() => Prepare(newInstance), "newly launched matching process blocks old consent");
  Assert(newInstance.Requests == 0, "new instance is not silently included in shutdown");

  var stubborn = new FakeSystem { Scan = _ => new[] { Original } };
  Reject<InvalidOperationException>(() => Prepare(stubborn), "remaining process must block installation");
  Assert(stubborn.Requests == 1 && stubborn.Delays == 2, "graceful request is attempted once with bounded polling");

  using (var cancel = new CancellationTokenSource()) {
   cancel.Cancel(); var cancelled = new FakeSystem { Scan = _ => new[] { Original } };
   Reject<OperationCanceledException>(() => Prepare(cancelled, token: cancel.Token), "pre-cancellation is respected");
   Assert(cancelled.Scans == 0 && cancelled.Requests == 0, "pre-cancellation performs no discovery or shutdown");
  }
  using (var cancel = new CancellationTokenSource()) {
   var cancelled = new FakeSystem { Scan = _ => new[] { Original } };
   Reject<OperationCanceledException>(() => Prepare(cancelled, (processes, token) => { cancel.Cancel(); return Task.FromResult(true); }, cancel.Token), "cancellation after confirmation is respected");
   Assert(cancelled.Requests == 0, "cancellation before request never reaches Restart Manager");
  }
  using (var cancel = new CancellationTokenSource()) {
   var cancelled = new FakeSystem { Scan = _ => new[] { Original }, Shutdown = cancel.Cancel };
   Reject<OperationCanceledException>(() => Prepare(cancelled, token: cancel.Token), "cancellation while waiting interrupts wait");
   Assert(cancelled.Requests == 1 && cancelled.Delays == 0, "cancelled wait never retries shutdown");
  }

  var anotherSession = new FakeSystem { Scan = _ => new[] { new RunningAppProcess(123, 456, Original.Executable, 8) } };
  Reject<InvalidOperationException>(() => Prepare(anotherSession, (processes, token) => { confirmations++; return Task.FromResult(true); }), "other Windows session requires manual exit");
  Assert(anotherSession.Requests == 0 && confirmations == 1, "other session never gets an automatic close request or prompt");

  var unreadable = new FakeSystem { Scan = _ => throw new InvalidOperationException("identity unavailable") };
  Reject<InvalidOperationException>(() => Prepare(unreadable), "unreadable candidate identity blocks install");
  Assert(unreadable.Requests == 0, "identity errors never attempt shutdown");
  Reject<InvalidOperationException>(() => RunningApplication.EnsureStopped(Target, stubborn), "final guard blocks a still-running image");
  Reject<InvalidOperationException>(() => RunningApplication.EnsureStopped(Target, unreadable), "final guard cannot ignore unreadable identity");
  RunningApplication.EnsureStopped(Target, sibling);
  Assert(sibling.Requests == 0, "final guard is read-only and ignores other install locations");
  Type nativeIdentity = typeof(WindowsRunningApplicationSystem).GetNestedType("UniqueProcess", BindingFlags.NonPublic)!;
  Assert(Marshal.SizeOf(nativeIdentity) == 12 && Marshal.OffsetOf(nativeIdentity, "Created").ToInt32() == 4, "Restart Manager PID/FILETIME layout matches Windows ABI");
  Console.WriteLine($"PASS: {checks} running-application assertions; fake process discovery/shutdown only.");
  return checks;
 }
}
