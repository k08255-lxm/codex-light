using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using CodexLight.Bootstrap;

// This executable is run only via the installed dotnet.exe host. It has no Window or apphost.
// UI source is shared with net48; this is not a net48 launch or physical-monitor test.
internal static class Tests {
 static int checks, renders;
 static void Assert(bool condition, string message) { checks++; if (!condition) throw new InvalidOperationException(message); }
 static void Fails(Action action, string message) { try { action(); } catch (InvalidOperationException) { checks++; return; } throw new Exception(message); }
 static void PackageContracts(){
  Assert(SetupEngine.PackageFileName("0.3.0")=="CodexLight-0.3.0-x64.msi","published MSI source filename preserved");
  Assert(SetupEngine.PackageFileName("0.4.0")=="CodexLight-0.4.0-x64.msi","next MSI source filename follows embedded version");
  foreach(string version in new[]{"","0.4","0.4.0.1","0.4.0+commit","../0.4.0","256.0.0","0.256.0","0.4.65536"})Fails(()=>SetupEngine.PackageFileName(version),"invalid package version refused");
  string fresh=SetupEngine.MsiArguments(@"C:\cache\CodexLight-0.4.0-x64.msi",@"C:\Apps\CodexLight",@"C:\cache\install.log");
  string repair=SetupEngine.MsiArguments(@"C:\cache\CodexLight-0.4.0-x64.msi",@"C:\Apps\CodexLight",@"C:\cache\install.log",true);
  Assert(!fresh.Contains("REINSTALL="),"fresh/major upgrade must not use REINSTALL=ALL");
  Assert(repair.Contains("REINSTALL=ALL REINSTALLMODE=vomus"),"same product repair re-caches exact source package");
  Assert(fresh.Contains("MSIRESTARTMANAGERCONTROL=DisableShutdown")&&repair.Contains("MSIRESTARTMANAGERCONTROL=DisableShutdown"),"never request automatic application shutdown");
 }
 static int PackageOnly(string source,string evidence){
  PackageContracts();Directory.CreateDirectory(evidence);
  var original=EmbeddedPackage.Read(source);
  byte[] Hash(string file){using(var input=File.OpenRead(file))using(var sha=System.Security.Cryptography.SHA256.Create())return sha.ComputeHash(input);}
  byte[] expected=Hash(source);
  for(int i=0;i<3;i++){
   string cache=Path.Combine(evidence,"extract-"+i+"-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(cache);
   EmbeddedPackage extracted;using(var input=File.OpenRead(source))extracted=SetupEngine.ExtractPackage(input,cache,System.Threading.CancellationToken.None).GetAwaiter().GetResult();
   Assert(Path.GetFileName(extracted.Path)==SetupEngine.PackageFileName(original.Version),"actual extracted filename matches MSI source convention");
   Assert(extracted.Version==original.Version&&extracted.ProductCode==original.ProductCode,"embedded identity retained across repeated extractions");
   Assert(expected.SequenceEqual(Hash(extracted.Path)),"extracted MSI bytes preserved");
   Assert(!File.Exists(Path.Combine(cache,"CodexLight.msi"))&&!File.Exists(Path.Combine(cache,"embedded.msi")),"ambiguous extraction filenames never reach msiexec");
  }
  File.WriteAllText(Path.Combine(evidence,"package-source-report.json"),System.Text.Json.JsonSerializer.Serialize(new{passed=true,assertions=checks,version=original.Version,repeatedExtractions=3,sourceHashUnchanged=expected.SequenceEqual(Hash(source)),installersStarted=0,installedStateChanged=false}));
  Console.WriteLine($"PASS: {checks} MSI source/identity/repair-contract assertions; three actual package extractions. No installer or product started; no installed-state changes.");return 0;
 }
 static IEnumerable<DependencyObject> Descendants(DependencyObject parent) {
  for (int i=0;i<VisualTreeHelper.GetChildrenCount(parent);i++) { var child=VisualTreeHelper.GetChild(parent,i); yield return child; foreach(var descendant in Descendants(child)) yield return descendant; }
 }
 static Rect Bounds(FrameworkElement control, Visual ancestor) => control.TransformToAncestor(ancestor).TransformBounds(new Rect(control.RenderSize));
 static void Layout(SetupView view, double? height=null) {
  view.Measure(new Size(544, height ?? double.PositiveInfinity));
  view.Arrange(new Rect(0,0,544,height ?? view.DesiredSize.Height)); view.UpdateLayout();
 }
 static void ButtonFits(Button button) {
  if (button.Visibility != Visibility.Visible) return;
  var presenter=Descendants(button).OfType<ContentPresenter>().First();
  var size=new FormattedText(button.Content.ToString()!, System.Globalization.CultureInfo.CurrentUICulture, FlowDirection.LeftToRight, new Typeface(button.FontFamily,button.FontStyle,button.FontWeight,button.FontStretch),button.FontSize,Brushes.Black,VisualTreeHelper.GetDpi(button).PixelsPerDip);
  Assert(button.ActualHeight >= size.Height + 4, "button text height: "+button.Content);
  Assert(presenter.ActualWidth >= size.Width - 0.5 && presenter.ActualHeight >= size.Height - 0.5, "button content fits: "+button.Content);
 }
 static SetupView NewView(double scale) {
  var view=new SetupView(); VisualTreeHelper.SetRootDpi(view,new DpiScale(scale,scale));
  using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("CodexLight.Icon")) view.SetIcon(BitmapDecoder.Create(stream!,BitmapCreateOptions.None,BitmapCacheOption.OnLoad).Frames.OrderByDescending(frame=>frame.PixelWidth).First());
  view.Location.Text=@"C:\Users\这是一个包含很长中文用户名的目录\AppData\Local\Programs\用于验证安装器路径不会被错误换行或裁切的中文文件夹\更长的安装父文件夹\CodexLight";
  view.Log("Node.js：可用 · 22.x"); view.Log(".NET Desktop Runtime：可用 · 10.x"); view.Log("WebView2：可用"); return view;
 }
 static void AssertLayout(SetupView view, double scale, bool expanded) {
  Assert(Math.Abs(view.FontSize-13)<0.01 && Math.Abs(view.Mode.FontSize-22)<0.01,"DIP fonts never multiplied");
  Assert(Math.Abs(VisualTreeHelper.GetDpi(view).DpiScaleX-scale)<0.001,"actual visual DPI");
  Assert(view.ActualWidth==544,"fixed content DIP width");
  Assert(view.Location.TextWrapping==TextWrapping.NoWrap && view.Location.IsReadOnly,"single line selectable protected path");
  Assert((string)view.Location.ToolTip==view.Location.Text,"full path tooltip");
  view.Location.SelectAll(); Assert(view.Location.SelectionLength==view.Location.Text.Length,"path can be selected for copy"); view.Location.Select(0,0);
  var pathScroller=Descendants(view.Location).OfType<ScrollViewer>().First();
  Assert(pathScroller.ExtentWidth > pathScroller.ViewportWidth,"long path has horizontal scroll extent");
  Assert(view.Location.LineCount==1,"path remains one line");
  var footer=Bounds(view.Footer,view); var content=Bounds(view.ContentScroll,view);
  Assert(content.Bottom<=footer.Top+0.5,"content cannot overlap actions");
  foreach(var button in new[]{view.Primary,view.Secondary,view.Change}) ButtonFits(button);
  foreach(var button in new[]{view.Primary,view.Secondary}) if(button.Visibility==Visibility.Visible) {
   var bounds=Bounds(button,view); Assert(bounds.Bottom<=view.ActualHeight && bounds.Top>=footer.Top,"action always visible");
  }
  foreach(var text in new[]{view.Mode,view.Status,view.Note}) if(text.Visibility==Visibility.Visible) {
   Assert(text.ActualWidth+0.5>=text.DesiredSize.Width-text.Margin.Left-text.Margin.Right && text.ActualHeight+0.5>=text.DesiredSize.Height-text.Margin.Top-text.Margin.Bottom,$"text fully arranged at {scale}: {text.Text}; actual {text.ActualWidth}x{text.ActualHeight}, desired {text.DesiredSize}");
  }
  if(expanded) Assert(view.Details.ActualHeight>=160 && view.Details.ActualHeight<=180,"details bounded usable height");
 }
 static void Render(SetupView view,double scale,string path) {
  var bitmap=new RenderTargetBitmap((int)Math.Ceiling(view.ActualWidth*scale),(int)Math.Ceiling(view.ActualHeight*scale),96*scale,96*scale,PixelFormats.Pbgra32);
  bitmap.Render(view); var png=new PngBitmapEncoder(); png.Frames.Add(BitmapFrame.Create(bitmap)); using(var stream=File.Create(path)) png.Save(stream); renders++;
  Assert(bitmap.PixelWidth==(int)Math.Ceiling(544*scale),"render uses requested output DPI");
 }
 [STAThread] static int Main(string[] args) {
  try {
   if(args.Length==3&&args[0]=="--package-only")return PackageOnly(Path.GetFullPath(args[1]),Path.GetFullPath(args[2]));
   PackageContracts();
   string preview=args.Length>0?Path.GetFullPath(args[0]):Path.Combine(AppContext.BaseDirectory,"previews"); Directory.CreateDirectory(preview);
   Assert(ExitCodePolicy.IsSuccess(0)&&ExitCodePolicy.IsSuccess(3010)&&ExitCodePolicy.IsSuccess(1641),"success/reboot codes");
   foreach(int code in new[]{1603,1618,1638}) Fails(()=>ExitCodePolicy.RequireSuccess(code,"test"),"must surface installer failure");
   try { ExitCodePolicy.RequireSuccess(1602,"test"); throw new Exception("cancel misclassified"); } catch(OperationCanceledException) { checks++; }
   Assert(DependencyInstaller.PassiveArguments("node",@"C:\a b\node.msi")=="/i \"C:\\a b\\node.msi\" /passive /norestart","node argument quoting");
   Assert(DependencyInstaller.PassiveArguments("dotnet","x")=="/install /passive /norestart","dotnet passive"); Assert(DependencyInstaller.PassiveArguments("webview","x")=="/silent /install","webview unattended");
   foreach(string path in new[]{"relative",@"C:\",@"\\server\share\app","C:relative",@"\rootrelative",@"C:\"+new string('a',201)}) Fails(()=>InstallPaths.Validate(path,false),"unsafe path refused");
   string existing=Path.GetTempPath().TrimEnd('\\'); Fails(()=>InstallPaths.Validate(existing,false),"existing directory refused"); Assert(InstallPaths.Validate(existing,true)==existing,"registered folder allowed");
   string fresh=Path.Combine(Path.GetTempPath(),"CodexLight-Test-"+Guid.NewGuid().ToString("N")); Assert(InstallPaths.Validate(fresh,false)==fresh&&!Directory.Exists(fresh),"validation never creates target");
   string msiArgs=SetupEngine.MsiArguments(@"C:\pkg x.msi",@"C:\App x",@"C:\log x.log"); Assert(msiArgs.Contains("/qn /norestart /L*v")&&msiArgs.Contains("SETUP_PREREQUISITES_VERIFIED=1")&&msiArgs.Contains("INSTALLFOLDER=\"C:\\App x\""),"MSI invocation contract");
   Assert(StartupEnvironment.IntegrityIssue(0x1000)!=null&&StartupEnvironment.IntegrityIssue(0)!=null,"low integrity blocked"); Assert(StartupEnvironment.IntegrityIssue(0x2000)==null&&StartupEnvironment.IntegrityIssue(0x3000)==null,"medium/high allowed");
   Assert(SetupView.ProgressSummary("Node.js · 下载官方依赖（仅 HTTPS）：https://nodejs.org/package")=="Node.js · 正在下载…","download URL stays in details"); Assert(SetupView.ProgressSummary("正在安装 Codex Light…\nWindows Installer 日志：C:\\cache")=="正在安装 Codex Light…","log path stays in details");
   foreach(double scale in new[]{1d,1.25d,1.5d,1.75d,2d}) {
    var view=NewView(scale);
    foreach(SetupStage stage in Enum.GetValues<SetupStage>()) {
     view.SetStage(stage,"状态验证"); Assert(view.Primary.IsEnabled==(stage!=SetupStage.Checking&&stage!=SetupStage.Installing),"state action gating");
    }
    view.SetStage(SetupStage.Installing,"正在安装"); view.SetCancelAllowed(false); Assert(!view.Secondary.IsEnabled,"MSI critical section cannot cancel"); view.SetCancelAllowed(true); Assert(view.Secondary.IsEnabled,"downloads may cancel");
    view.Complete(3010); Assert((string)view.Primary.Content=="完成"&&view.Secondary.Visibility==Visibility.Collapsed&&view.Status.Text.Contains("重启"),"restart required one Done action");
    view.Complete(1641); Assert(view.Status.Text.Contains("已开始重启"),"restart initiated distinct");
    view.Complete(0); Assert((string)view.Primary.Content=="打开应用"&&(string)view.Secondary.Content=="完成","success offers explicit open and done");
    view.SetRegistered(true); view.SetStage(SetupStage.Ready,"运行环境已就绪。"); Assert((string)view.Primary.Content=="更新"&&view.Mode.Text.Contains("更新")&&!view.Change.IsEnabled,"registered MSI explicitly updates existing location");
    view.SetRegistered(false); view.SetStage(SetupStage.Ready,"运行环境已就绪。"); Assert((string)view.Primary.Content=="安装"&&view.Change.IsEnabled,"fresh install actions");
    Assert(view.Primary.IsDefault&&KeyboardNavigation.GetTabIndex(view.Change)<KeyboardNavigation.GetTabIndex(view.Primary),"keyboard default/tab order"); Assert(view.Primary.FocusVisualStyle!=null && view.Secondary.FocusVisualStyle!=null,"visible custom keyboard focus style");
    foreach(var scenario in new[]{"ready","installing","failed","completed"}) foreach(bool expanded in new[]{false,true}) {
     view.DetailsToggle.IsExpanded=expanded;
     if(scenario=="ready") { view.SetRegistered(true); view.SetStage(SetupStage.Ready,"运行环境已就绪。"); }
     else if(scenario=="installing") { view.SetStage(SetupStage.Installing,"Node.js · 下载进度：68%（18 MB / 27 MB）"); view.SetCancelAllowed(true); }
     else if(scenario=="failed") { view.SetStage(SetupStage.Failed,"安装未完成：无法连接到官方下载服务。请检查网络连接，然后点击“重试”。已完成的运行环境安装会保留。"); view.Log("测试错误详情：连接超时。没有执行网络、检测或安装。"); }
     else view.Complete(0);
     Layout(view); AssertLayout(view,scale,expanded); Render(view,scale,Path.Combine(preview,$"setup-{(int)(scale*100)}-{scenario}-{(expanded?"details":"collapsed")}.png"));
    }
    view.SetStage(SetupStage.Failed,string.Concat(Enumerable.Repeat("这是一段用于验证长错误内容可以滚动的完整中文错误说明。",24))); view.DetailsToggle.IsExpanded=true; Layout(view,360);
    Assert(view.ContentScroll.ScrollableHeight>0,"long error scrolls within capped viewport"); AssertLayout(view,scale,true); Render(view,scale,Path.Combine(preview,$"setup-{(int)(scale*100)}-long-error.png"));
    var blocked=NewView(scale); blocked.BlockStartup(StartupEnvironment.IntegrityIssue(0x1000)!); Layout(blocked); Assert(blocked.Primary.Visibility==Visibility.Collapsed&&!blocked.Primary.IsEnabled&&!blocked.Change.IsEnabled&&(string)blocked.Secondary.Content=="关闭","blocked startup only close");
   }
   foreach(bool update in new[]{false,true}) {
    var normal=NewView(1.75); normal.Location.Text=@"C:\Users\TestUser\AppData\Local\Programs\CodexLight"; normal.SetRegistered(update); normal.SetStage(SetupStage.Ready,"运行环境已就绪。"); Layout(normal);
    Assert(normal.Location.LineCount==1,"normal path single line"); ButtonFits(normal.Primary); ButtonFits(normal.Secondary); ButtonFits(normal.Change);
    Assert(Bounds(normal.ContentScroll,normal).Bottom<=Bounds(normal.Footer,normal).Top+0.5,"normal path footer separation");
    Render(normal,1.75,Path.Combine(preview,$"setup-175-normal-{(update?"update":"install")}.png"));
   }
   File.WriteAllText(Path.Combine(preview,"layout-report.json"),System.Text.Json.JsonSerializer.Serialize(new {
    passed=true, assertions=checks, pngPreviews=renders, dpiPercent=new[]{100,125,150,175,200},
    scenarios="Long Chinese path; Ready/Installing/Failed/Completed with details folded/expanded; bounded long-error scroll; normal fresh/update at 175%; all stage/cancel/restart/startup-block state checks",
    method="Shared SetupView.cs on net10.0-windows via installed system dotnet.exe; SetRootDpi + Measure/Arrange + RenderTargetBitmap; no manual font scaling",
    boundary="Not a net48 launch or physical-monitor test. No Window/HwndSource construction, generated apphost, Setup/product launch, dependency detection, network, installers or foreground input."
   },new System.Text.Json.JsonSerializerOptions{WriteIndented=true}));
   Console.WriteLine($"PASS: {checks} assertions, {renders} offscreen PNGs. Shared WPF sources on net10; no Window/HwndSource construction, generated apphost, Setup/product launch, detection, network, installers or foreground input.");
   return 0;
  } catch(Exception error) { Console.Error.WriteLine(error); return 1; }
 }
}
