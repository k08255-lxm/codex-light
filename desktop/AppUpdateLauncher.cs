using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace CodexLight.Desktop;

// Launch from the native host: its backend belongs to a kill-on-close Job.
internal static class AppUpdateLauncher {
 public static void Launch(string installerPath, string sha256) {
  if (sha256 is null || !Regex.IsMatch(sha256, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant)) throw new InvalidOperationException("安装包校验信息无效");
  var root = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexLight", "Updates"));
  var target = Path.GetFullPath(installerPath);
  var directory = Path.GetDirectoryName(target) ?? throw new InvalidOperationException("安装包路径无效");
  if (!string.Equals(Path.GetDirectoryName(directory), root, StringComparison.OrdinalIgnoreCase)
      || !Regex.IsMatch(Path.GetFileName(directory), "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-[a-f0-9]{16}$", RegexOptions.CultureInvariant)
      || !string.Equals(Path.GetFileName(target), "CodexLight-Setup.exe", StringComparison.Ordinal)
      || !Path.GetFileName(directory).EndsWith("-" + sha256[..16], StringComparison.Ordinal)) throw new InvalidOperationException("安装包不在应用更新缓存中");
  for (string? current = target; current is not null; current = Path.GetDirectoryName(current)) {
   if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("安装包路径不能包含链接");
  }
  var info = new FileInfo(target);
  if (info.Length < 1 || info.Length > 300L * 1024 * 1024) throw new InvalidOperationException("安装包大小无效");
  using (var stream = File.Open(target, FileMode.Open, FileAccess.Read, FileShare.Read)) {
   var actual = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
   if (!string.Equals(actual, sha256, StringComparison.Ordinal)) throw new InvalidOperationException("安装包 SHA256 校验失败");
   // No arguments or shell command are accepted. The normal interactive installer remains visible.
   using var process = Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
   if (process is null) throw new AppUpdateLaunchUnknownException();
  }
 }
}
internal sealed class AppUpdateLaunchUnknownException : Exception { }
