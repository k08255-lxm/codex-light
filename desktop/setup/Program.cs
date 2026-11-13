using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace CodexLight.Bootstrap {
 internal sealed class SetupWindow : Window {
  readonly SetupView view = new SetupView();
  bool checking, busy, registered, restartRequired, checkFailed, closeAfterCheck, loaded;
  volatile bool cancelAllowed;
  CancellationTokenSource? cancellation;
  readonly Stopwatch elapsed = new Stopwatch();
  readonly DispatcherTimer elapsedTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };

  public SetupWindow(string? startupIssue = null) {
   Title = "安装 Codex Light"; Content = view;
   SizeToContent = SizeToContent.WidthAndHeight; ResizeMode = ResizeMode.CanMinimize; WindowStartupLocation = WindowStartupLocation.CenterScreen;
   // WPF owns monitor scaling. All content sizes and fonts are DIPs.
   MaxHeight = SystemParameters.WorkArea.Height;
   using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("CodexLight.Icon")) {
    if (stream != null) { var image = BitmapDecoder.Create(stream, BitmapCreateOptions.None, BitmapCacheOption.OnLoad).Frames.OrderByDescending(frame => frame.PixelWidth).First(); Icon = image; view.SetIcon(image); }
   }
   view.Location.Text = InstallPaths.Default;
   elapsedTimer.Tick += (_, __) => view.SetElapsed(elapsed.Elapsed);
   Closed += (_, __) => elapsedTimer.Stop();
   view.Change.Click += (_, __) => ChangeDirectory();
   view.Primary.Click += async (_, __) => {
    if (view.Stage == SetupStage.Completed) { OpenApp(); return; }
    if (view.Stage == SetupStage.Checking || checking) return;
    if (checkFailed) { await CheckAsync(); return; }
    await InstallAsync();
   };
   view.Secondary.Click += (_, __) => CancelOrClose();
   PreviewKeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Escape && view.Secondary.IsEnabled && view.Secondary.Visibility == Visibility.Visible) { e.Handled = true; CancelOrClose(); } };
   Loaded += async (_, __) => { if (loaded) return; loaded = true; if (startupIssue != null) { view.BlockStartup(startupIssue); return; } await CheckAsync(); };
   Closing += (_, e) => {
    if (!busy && !checking) return;
    e.Cancel = true;
    if (checking) { closeAfterCheck = true; view.SetMessage("正在结束环境检查，完成后关闭…"); }
    else RequestCancel();
   };
  }
  sealed class DialogOwner : Forms.IWin32Window {
   public IntPtr Handle { get; }
   public DialogOwner(IntPtr handle) { Handle = handle; }
  }
  void ChangeDirectory() {
   using (var dialog = new Forms.FolderBrowserDialog { Description = "选择父文件夹，安装器会在其中创建 CodexLight 文件夹。无需预先新建目录。", SelectedPath = Path.GetDirectoryName(view.Location.Text), ShowNewFolderButton = true }) {
    if (dialog.ShowDialog(new DialogOwner(new WindowInteropHelper(this).Handle)) != Forms.DialogResult.OK) return;
    view.Location.Text = InstallPaths.UnderParent(dialog.SelectedPath); view.SetMessage("准备安装。所需运行环境会自动检查。");
   }
  }
  void StartElapsed() { elapsed.Restart(); view.SetElapsed(elapsed.Elapsed); elapsedTimer.Start(); }
  void StopElapsed() { elapsed.Stop(); elapsedTimer.Stop(); view.SetElapsed(elapsed.Elapsed); }
  void AllowCancel(bool allowed) { cancelAllowed = allowed; view.SetCancelAllowed(allowed); }
  void CancelOrClose() { if (!view.Secondary.IsEnabled) return; if (busy) RequestCancel(); else Close(); }
  void RequestCancel() { if (!cancelAllowed) return; cancellation?.Cancel(); view.Secondary.IsEnabled = false; view.SetMessage("正在取消，等待当前操作安全结束…"); }
  async Task CheckAsync() {
   checking = true; checkFailed = false; view.SetStage(SetupStage.Checking, "正在检查运行环境…");
   StartElapsed();
   try {
    string? previous = await Task.Run(() => InstallPaths.Registered()); registered = previous != null;
    view.SetRegistered(registered); Title = registered ? "更新 Codex Light" : "安装 Codex Light"; if (previous != null) view.Location.Text = previous;
    string target = view.Location.Text;
    var states = await Task.Run(() => Detection.Read(target));
    foreach (var state in states) view.Log(state.Name + "：" + (state.Compatible ? "可用" : "需要安装") + " · " + state.Detail);
    int missing = states.Count(x => !x.Compatible);
    view.SetStage(SetupStage.Ready, missing == 0 ? "运行环境已就绪。" : "将自动安装 " + missing + " 项必要运行环境。");
    if (registered) view.Log("检测到 Windows Installer 登记；更新将使用原安装位置。");
   } catch (Exception error) { checkFailed = true; view.Log(error.ToString()); view.SetStage(SetupStage.Failed, "环境检查未完成：" + error.Message); }
   finally { StopElapsed(); checking = false; if (closeAfterCheck) Close(); }
  }
  async Task InstallAsync() {
   busy = true; cancellation = new CancellationTokenSource(); view.SetStage(SetupStage.Installing, "正在检查运行环境…"); AllowCancel(true);
   StartElapsed();
   var messages = new Progress<string>(message => view.Log(message));
   var cancel = new Progress<bool>(allowed => { if (busy && cancellation?.IsCancellationRequested != true) view.SetCancelAllowed(allowed); });
   var progress = new Progress<SetupProgress>(update => { if (view.Stage == SetupStage.Installing && cancellation?.IsCancellationRequested != true) view.SetProgress(update); });
   try { int code = await new SetupEngine().Run(view.Location.Text, registered, ((IProgress<string>)messages).Report, allowed => { cancelAllowed = allowed; ((IProgress<bool>)cancel).Report(allowed); }, cancellation.Token, progress); restartRequired = code == 3010 || code == 1641; view.Complete(code); }
   catch (OperationCanceledException error) { view.Log(error.Message); view.SetStage(SetupStage.Cancelled, "安装已取消。已完成的运行环境安装会保留，可点击“重试”继续。"); }
   catch (Exception error) { view.Log(error.ToString()); view.SetStage(SetupStage.Failed, "安装未完成：" + error.Message); }
   finally { StopElapsed(); busy = false; cancellation.Dispose(); cancellation = null; }
  }
  void OpenApp() {
   if (restartRequired) { Close(); return; }
   try { Process.Start(new ProcessStartInfo(Path.Combine(view.Location.Text, "CodexLight.exe")) { UseShellExecute = true, WorkingDirectory = view.Location.Text }); Close(); }
   catch (Exception error) { view.Log(error.ToString()); view.SetMessage("打开失败：" + error.Message); }
  }
 }
 internal static class Program {
  [STAThread] static void Main() {
   // Programmatic switches preserve the single-file release without an App.config sidecar.
   AppContext.SetSwitch("Switch.System.Windows.DoNotScaleForDpiChanges", false);
   AppContext.SetSwitch("Switch.System.Windows.DoNotUsePresentationDpiCapabilityTier2OrGreater", false);
   Run();
  }
  [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
  static void Run() { new Application().Run(new SetupWindow(StartupEnvironment.ReadIntegrityIssue())); }
 }
}
