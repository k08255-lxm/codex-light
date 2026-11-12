using System.Reflection;
using System.Text.Json;
using CodexLight.Desktop;
using Microsoft.Web.WebView2.WinForms;
internal static class StartupTest {
 [STAThread] static int Main(string[] args){
  bool demo=!args.Contains("--real");
  ApplicationConfiguration.Initialize();using var form=new MainWindow(demo);form.ShowInTaskbar=false;_ = form.Handle;
  Application.Idle+=Run;int exit=1;
  async void Run(object? sender,EventArgs e){
   Application.Idle-=Run;
   try{
    var type=typeof(MainWindow);const BindingFlags flags=BindingFlags.Instance|BindingFlags.NonPublic;
    var view=(WebView2)type.GetField("view",flags)!.GetValue(form)!;_ = view.Handle;
    await ((Task)type.GetMethod("StartAsync",flags)!.Invoke(form,null)!).WaitAsync(TimeSpan.FromSeconds(45));
    view=(WebView2)type.GetField("view",flags)!.GetValue(form)!;
    bool failed=(bool)type.GetField("failed",flags)!.GetValue(form)!;
    var label=(Label)type.GetField("loading",flags)!.GetValue(form)!;
    bool ready=view.CoreWebView2!=null&&!failed;string body="";
    if(ready){for(int i=0;i<120;i++){body=await view.CoreWebView2!.ExecuteScriptAsync("document.getElementById('new-thread') !== null && document.getElementById('connection-dot')?.classList.contains('ok') === true");if(body=="true")break;await Task.Delay(250);}}
    exit=ready&&body=="true"?0:1;
    Console.WriteLine(JsonSerializer.Serialize(new{ok=exit==0,demo,stage=type.GetField("startupStage",flags)!.GetValue(form),error=failed?label.Text:null,version=view.CoreWebView2?.Environment.BrowserVersionString,visible=form.Visible}));
    await (Task)type.GetMethod("StopBackendAsync",flags)!.Invoke(form,null)!;
    view.Dispose();await (Task)type.GetMethod("CleanupProfileAsync",flags)!.Invoke(form,null)!;
    if(exit==0&&demo){await CheckRuntimeFallback();await CheckBackendExitDuringInitialization();}
   }catch(Exception ex){exit=1;Console.WriteLine(ex.GetType().Name+" 0x"+ex.HResult.ToString("X8"));}
   finally{form.Dispose();Application.ExitThread();}
  }
  Application.Run();return exit;
 }
 static async Task CheckBackendExitDuringInitialization(){
  const BindingFlags flags=BindingFlags.Instance|BindingFlags.NonPublic;var type=typeof(MainWindow);
  using var form=new MainWindow(true);form.ShowInTaskbar=false;_ = form.Handle;bool killed=false;
  form.ControlAdded+=(_,e)=>{
   if(e.Control is WebView2&&type.GetField("backend",flags)!.GetValue(form) is System.Diagnostics.Process process){process.Kill(true);killed=true;}
  };
  await ((Task)type.GetMethod("StartAsync",flags)!.Invoke(form,null)!).WaitAsync(TimeSpan.FromSeconds(45));
  await Task.Delay(100);
  var label=(Label)type.GetField("loading",flags)!.GetValue(form)!;
  if(!killed||!(bool)type.GetField("failed",flags)!.GetValue(form)!||!label.Text.Contains("本地后台退出")||form.Visible)throw new Exception("backend exit was hidden by WebView progress");
  await (Task)type.GetMethod("StopBackendAsync",flags)!.Invoke(form,null)!;
  ((WebView2)type.GetField("view",flags)!.GetValue(form)!).Dispose();
  await (Task)type.GetMethod("CleanupProfileAsync",flags)!.Invoke(form,null)!;
  Console.WriteLine("PASS backend exit during WebView initialization preserves failure and cancels startup");
 }
 static async Task CheckRuntimeFallback(){
  using var parent=new Form{ShowInTaskbar=false};_ = parent.Handle;
  string directory=Path.Combine(AppContext.BaseDirectory,"runtime-check-"+Guid.NewGuid().ToString("N"));
  var absent=new WebViewCandidate("missing",Path.Combine(directory,"absent"));
  var session=await WebViewRuntime.StartAsync(parent,directory,new[]{absent,new WebViewCandidate("default",null)},_=>{},CancellationToken.None);
  if(session.Attempts.Count!=2||session.Attempts[0].Error==null||session.Attempts[1].Error!=null||parent.Visible)throw new Exception("runtime fallback failed");
  session.View.Dispose();Console.WriteLine("PASS missing runtime falls back to initialized installed runtime, window hidden");
  try{await WebViewRuntime.StartAsync(parent,directory,new[]{absent},_=>{},CancellationToken.None);throw new Exception("missing runtime was accepted");}
  catch(WebViewStartupException error){if(error.Attempts.Count!=1||error.Attempts[0].Error==null)throw;Console.WriteLine("PASS unavailable runtimes report failure");}
  using var cancelled=new CancellationTokenSource();cancelled.Cancel();
  try{await WebViewRuntime.StartAsync(parent,directory,new[]{absent},_=>{},cancelled.Token);throw new Exception("cancelled startup was accepted");}
  catch(OperationCanceledException){Console.WriteLine("PASS cancelled startup stops before initialization");}
  for(int i=0;i<10;i++){try{if(Directory.Exists(directory))Directory.Delete(directory,true);break;}catch(IOException){await Task.Delay(200);}catch(UnauthorizedAccessException){await Task.Delay(200);}}
 }
}
