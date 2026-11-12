using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CodexLight.Desktop;

internal sealed record WebViewCandidate(string Name,string? Folder);
internal sealed record WebViewAttempt(string Runtime,string? Version,string Stage,string? Error);
internal sealed record WebViewSession(WebView2 View,CoreWebView2Environment Environment,IReadOnlyList<WebViewAttempt> Attempts);
internal sealed class WebViewStartupException(IReadOnlyList<WebViewAttempt> attempts):Exception("没有可启动的 WebView2 运行环境") {
 public IReadOnlyList<WebViewAttempt> Attempts { get; }=attempts;
 public string Details=>string.Join("；",Attempts.Select(a=>$"{a.Runtime}{(a.Version==null?"":" "+a.Version)}：{a.Stage} {a.Error}"));
}

internal static class WebViewRuntime {
 internal const int MinimumMajor=142;
 public static IReadOnlyList<WebViewCandidate> Discover(string applicationDirectory){
  // The loader chooses the registered machine/user runtime and honors WebView2 policy.
  var candidates=new List<WebViewCandidate>{new("系统默认",null)};
  string bundled=Path.Combine(applicationDirectory,"runtime","webview2");
  if(File.Exists(Path.Combine(bundled,"msedgewebview2.exe")))candidates.Add(new("随附运行时",bundled));
  var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  foreach(string baseFolder in new[]{Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)}){
   string root=Path.Combine(baseFolder,"Microsoft","EdgeWebView","Application");
   if(!seen.Add(root)||!Directory.Exists(root))continue;
   try{
    // Updaters can leave a registered version unusable while another installed
    // version still works. Do not scan arbitrary folders or launch Edge itself.
    foreach(string folder in Directory.GetDirectories(root)
      .Where(p=>Version.TryParse(Path.GetFileName(p),out var v)&&v.Major>=MinimumMajor)
      .OrderByDescending(p=>Version.Parse(Path.GetFileName(p))).Take(3)){
     if(File.Exists(Path.Combine(folder,"msedgewebview2.exe")))candidates.Add(new("已安装运行时",folder));
    }
   }catch(UnauthorizedAccessException){}catch(IOException){} // Default discovery still reports runtime failures below.
  }
  return candidates;
 }

 public static async Task<WebViewSession> StartAsync(Control parent,string profilesRoot,IEnumerable<WebViewCandidate> candidates,Action<string> progress,CancellationToken cancellation){
  var attempts=new List<WebViewAttempt>();
  foreach(var candidate in candidates){
   cancellation.ThrowIfCancellationRequested();
   string? version=null;string stage="检测";WebView2? view=null;
   try{
    version=CoreWebView2Environment.GetAvailableBrowserVersionString(candidate.Folder);
    if(!Version.TryParse(version.Split(' ')[0],out var parsed)||parsed.Major<MinimumMajor){attempts.Add(new(candidate.Name,version,stage,"版本过旧"));continue;}
    progress($"正在启动 WebView2 {version}…");stage="创建环境";
    cancellation.ThrowIfCancellationRequested();
    string profile=Path.Combine(profilesRoot,Guid.NewGuid().ToString("N"));
    var environment=await CoreWebView2Environment.CreateAsync(candidate.Folder,profile).WaitAsync(TimeSpan.FromSeconds(20),cancellation);
    cancellation.ThrowIfCancellationRequested();
    stage="初始化控件";view=new WebView2{Dock=DockStyle.Fill};parent.Controls.Add(view);_ = view.Handle;
    var options=environment.CreateCoreWebView2ControllerOptions();options.IsInPrivateModeEnabled=true;
    await view.EnsureCoreWebView2Async(environment,options).WaitAsync(TimeSpan.FromSeconds(20),cancellation);
    cancellation.ThrowIfCancellationRequested();
    attempts.Add(new(candidate.Name,environment.BrowserVersionString,"就绪",null));
    return new(view,environment,attempts);
   }catch(TimeoutException error){
    if(view!=null){parent.Controls.Remove(view);view.Dispose();}
    attempts.Add(new(candidate.Name,version,stage,$"{error.GetType().Name} 0x{error.HResult:X8}"));
    // A pending COM creation has no cancellation API. Do not queue more creations.
    throw new WebViewStartupException(attempts);
   }catch(Exception error)when(IsRuntimeFailure(error)){
    // A failed WinForms WebView cannot be reinitialized; recreate it for the next runtime.
    if(view!=null){parent.Controls.Remove(view);view.Dispose();}
    attempts.Add(new(candidate.Name,version,stage,$"{error.GetType().Name} 0x{error.HResult:X8}"));
    progress($"WebView2 {version??candidate.Name} 未能启动，正在检查其他已安装版本…");
   }catch{
    if(view!=null){parent.Controls.Remove(view);view.Dispose();}throw;
   }
  }
  throw new WebViewStartupException(attempts);
 }
 static bool IsRuntimeFailure(Exception error)=>error is WebView2RuntimeNotFoundException||error is FileNotFoundException||error is DirectoryNotFoundException||
  error is COMException com&&com.HResult is unchecked((int)0x8000FFFF) or unchecked((int)0x80004005) or unchecked((int)0x80070002) or unchecked((int)0x80070003) or unchecked((int)0x80070005) or unchecked((int)0x8007139F);
}
