using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
namespace CodexLight.Desktop;
internal sealed class MainWindow : CaptionWindow {
 WebView2 view=new(){Dock=DockStyle.Fill};
 readonly Label loading=new(){Dock=DockStyle.Fill,Text="正在启动本地 Codex Light…",TextAlign=ContentAlignment.MiddleCenter,ForeColor=Color.White,BackColor=Color.FromArgb(24,24,24)};
 readonly bool demo; readonly string profile=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLight","WebView","Sessions",Guid.NewGuid().ToString("N"));
 readonly CancellationTokenSource hostMessages=new();
 readonly SemaphoreSlim hostWrites=new(1,1);
 NotifyIcon? tray;ContextMenuStrip? trayMenu;Icon? trayIcon;
 Process? backend;ChildJob? job;Uri? origin;bool closing,allowClose,exitRequested,choosingClose,resourcesDisposed,failed;
 readonly WindowSessionEnd sessionEnd=new();
 Task? stopTask;
 string startupStage="检测运行环境";
 readonly WindowPlacementController placement;
 public MainWindow(bool demo){this.demo=demo;Text="Codex Light";Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);Size=new Size(1257,945);MinimumSize=new Size(800,600);BackColor=Color.FromArgb(24,24,24);Controls.Add(view);Controls.Add(loading);BuildCaptionMenu();placement=new WindowPlacementController(this,WindowPlacementStore.ForCurrentUser());Shown+=async(_,_)=>await StartAsync();FormClosing+=OnClosing;}
 protected override void OnLoad(EventArgs e){base.OnLoad(e);placement.Restore();}
 protected override void OnMove(EventArgs e){base.OnMove(e);placement?.Capture();}
 protected override void OnResize(EventArgs e){base.OnResize(e);placement?.Capture();}
 protected override void OnResizeEnd(EventArgs e){base.OnResizeEnd(e);placement.Capture();placement.Save();}
 async Task StartAsync(){
  try {
   if(CodexLight.Runtime.ProcessIntegrity.ReadLevel()<0x2000){
    ShowFailure("当前程序带有受限权限标记，无法写入应用数据。\n请解压正式发行包并使用 CodexLight-Setup.exe 安装。");return;
   }
   string root=Path.Combine(AppContext.BaseDirectory,"app"),script=Path.Combine(root,"src","desktop-backend.mjs");
   if(!File.Exists(script))throw new InvalidOperationException("缺少 app/src/desktop-backend.mjs，请使用完整发行目录。");
   var nodeRuntime=await Task.Run(()=>CodexLight.Runtime.NodeRuntimeDetection.FindCompatible(AppContext.BaseDirectory));
   if(nodeRuntime==null)throw new FileNotFoundException("未发现 Node.js 20+，请运行安装器补齐运行环境。");
   if(closing)return;
   string node=nodeRuntime.Path;startupStage="创建后台进程";job=new ChildJob();
   var utf8=new UTF8Encoding(false);
   var start=new ProcessStartInfo(node){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardInputEncoding=utf8,StandardOutputEncoding=utf8,StandardErrorEncoding=utf8,WorkingDirectory=root};
   start.ArgumentList.Add(script);if(demo)start.ArgumentList.Add("--demo");
   backend=new Process{StartInfo=start,EnableRaisingEvents=true};
   backend.Exited+=(sender,eventArgs)=>{try{int code=((Process)sender!).ExitCode;if(!closing&&stopTask==null&&IsHandleCreated)BeginInvoke((Action)(()=>{if(stopTask==null){ShowFailure($"本地后台退出（{startupStage}，退出码 {code}）。请重新打开应用。");_ = StopBackendAsync();}}));}catch(InvalidOperationException){}};
   if(!backend.Start())throw new InvalidOperationException("无法启动 Node 后台。");
   startupStage="绑定后台进程";try{job.Assign(backend);}catch{backend.Kill(true);throw;}
   backend.ErrorDataReceived+=(_,_)=>{};backend.BeginErrorReadLine(); // never persist secrets/diagnostics
   startupStage="后台握手";await WriteHostAsync("{\"action\":\"start\"}");
   using var timeout=CancellationTokenSource.CreateLinkedTokenSource(hostMessages.Token);timeout.CancelAfter(TimeSpan.FromSeconds(30));
   string line=await ReadBoundedLineAsync(backend.StandardOutput,timeout.Token);
   using var result=JsonDocument.Parse(line);string? url=result.RootElement.GetProperty("url").GetString();
   if(!Uri.TryCreate(url,UriKind.Absolute,out var uri)||uri.Scheme!="http"||uri.Host!="127.0.0.1"||uri.Port<=0||uri.AbsolutePath!="/"||uri.Query!=""||uri.UserInfo!=""||!Regex.IsMatch(uri.Fragment,"^#token=[a-f0-9]{64}$"))throw new InvalidOperationException("后台返回了无效本地地址。");
   if(closing)return;origin=new Uri(uri.GetLeftPart(UriPartial.Authority));
   startupStage="初始化 WebView2";
   Controls.Remove(view);view.Dispose();
   var session=await WebViewRuntime.StartAsync(this,profile,WebViewRuntime.Discover(AppContext.BaseDirectory),message=>{if(!closing&&!failed){loading.Text=message;loading.BringToFront();}},hostMessages.Token);
   view=session.View;var environment=session.Environment;
   WriteStartupReport(session.Attempts,true);
   if(closing)return;
   var core=view.CoreWebView2;var settings=core.Settings;
   settings.AreDevToolsEnabled=false;settings.AreDefaultContextMenusEnabled=true;settings.AreBrowserAcceleratorKeysEnabled=false;
   // Keep WebView2's native editing commands and clipboard handling, without browser navigation/search actions.
   // AreBrowserAcceleratorKeysEnabled=false does not disable Ctrl+C/X/V/A/Z.
   core.ContextMenuRequested+=(_,e)=>{
    var target=e.ContextMenuTarget;
    if(!target.HasSelection&&!target.IsEditable){e.Handled=true;return;}
    for(int i=e.MenuItems.Count-1;i>=0;i--){
     string name=e.MenuItems[i].Name;
     bool keep=(name is "copy" or "selectAll")||(target.IsEditable&&(name is "cut" or "paste" or "undo" or "redo" or "delete"));
     if(!keep)e.MenuItems.RemoveAt(i);
    }
    if(e.MenuItems.Count==0)e.Handled=true;
   };
   settings.IsWebMessageEnabled=false;settings.IsStatusBarEnabled=false;settings.IsPasswordAutosaveEnabled=false;settings.IsGeneralAutofillEnabled=false;
   core.PermissionRequested+=(_,e)=>{e.State=CoreWebView2PermissionState.Deny;e.Handled=true;};
   core.DownloadStarting+=(_,e)=>{e.Cancel=true;e.Handled=true;};
   core.NewWindowRequested+=(_,e)=>{e.Handled=true;if(e.IsUserInitiated)QueueExternal(e.Uri);};
   core.NavigationStarting+=(_,e)=>{if(!IsOwn(e.Uri)){e.Cancel=true;if(e.IsUserInitiated && !e.IsRedirected)QueueExternal(e.Uri);}};
   core.FrameNavigationStarting+=(_,e)=>{e.Cancel=true;};
   core.LaunchingExternalUriScheme+=(_,e)=>{e.Cancel=true;};
   core.ServerCertificateErrorDetected+=(_,e)=>{e.Action=CoreWebView2ServerCertificateErrorAction.Cancel;};
   core.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
   core.WebResourceRequested+=(_,e)=>{if(!IsOwn(e.Request.Uri)&&!e.Request.Uri.StartsWith("blob:"+origin.GetLeftPart(UriPartial.Authority)+"/",StringComparison.Ordinal)&&!e.Request.Uri.StartsWith("data:image/",StringComparison.Ordinal))e.Response=environment.CreateWebResourceResponse(null,403,"Blocked","");};
   core.ProcessFailed+=(_,_)=>ShowFailure("桌面渲染进程异常。请关闭后重新打开；不会自动重发任务。");
   core.NavigationCompleted+=(_,e)=>{if(e.IsSuccess){if(!failed)loading.Hide();}else ShowFailure("页面加载失败。请关闭并重新打开应用。");};
   if(HasIntegratedCaption){
    // Host-only style: preserve browser mode while removing the duplicate WebUI bar.
    await core.AddScriptToExecuteOnDocumentCreatedAsync("document.addEventListener('DOMContentLoaded',()=>{document.documentElement.classList.add('native-caption-integrated');});");
   }
   startupStage="载入界面";core.Navigate(uri.AbsoluteUri);
   _ = ReadHostMessagesAsync(backend.StandardOutput);
  }catch(Exception error){
   if(error is WebViewStartupException web){WriteStartupReport(web.Attempts,false);if(!closing)ShowFailure("WebView2 无法启动。请查看启动诊断中的版本、错误码及应用数据目录权限。\n"+web.Details);}
   else if(!closing)ShowFailure($"启动失败（{startupStage}，{error.GetType().Name}，0x{error.HResult:X8}）。"+(startupStage=="检测运行环境"?"请运行安装器检查 Node.js 与应用文件。":"请检查本机运行环境。"));
   await StopBackendAsync();
  }
 }
 static void WriteStartupReport(IReadOnlyList<WebViewAttempt> attempts,bool ready){
  try{
   string directory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLight","logs");Directory.CreateDirectory(directory);
   // No local URL, token, request data or environment dump is written.
   File.WriteAllText(Path.Combine(directory,"webview-startup.json"),JsonSerializer.Serialize(new{time=DateTimeOffset.UtcNow,ready,attempts}));
  }catch(IOException){}catch(UnauthorizedAccessException){} // Optional diagnostics must not prevent startup.
 }
 async Task ReadHostMessagesAsync(StreamReader reader){
  try{
   while(!closing){
    string line=await ReadBoundedLineAsync(reader,hostMessages.Token);
    using var document=JsonDocument.Parse(line);var message=document.RootElement;
    if(message.ValueKind!=JsonValueKind.Object||!message.TryGetProperty("type",out var type)||type.ValueKind!=JsonValueKind.String)throw new InvalidDataException();
    if(type.GetString()=="pickFolder"){
     if(message.EnumerateObject().Count()!=2||!message.TryGetProperty("requestId",out var request)||request.ValueKind!=JsonValueKind.String||!Guid.TryParseExact(request.GetString(),"D",out var id))throw new InvalidDataException();
     await PickFolderAsync(id.ToString("D"));continue;
    }
    if(type.GetString()=="launchInstaller"){
     if(message.EnumerateObject().Count()!=4||!message.TryGetProperty("requestId",out var request)||request.ValueKind!=JsonValueKind.String||!Guid.TryParseExact(request.GetString(),"D",out var id)
        ||!message.TryGetProperty("path",out var installer)||installer.ValueKind!=JsonValueKind.String||!message.TryGetProperty("sha256",out var digest)||digest.ValueKind!=JsonValueKind.String)throw new InvalidDataException();
     string installerPath=installer.GetString()!,sha256=digest.GetString()!;
     if(installerPath.Length==0||installerPath.Length>4096||installerPath.Contains('\0')||!Path.IsPathFullyQualified(installerPath)||sha256.Length!=64||sha256.Any(c=>!((c>='0'&&c<='9')||(c>='a'&&c<='f'))))throw new InvalidDataException();
     await LaunchInstallerAsync(id.ToString("D"),installerPath,sha256);continue;
    }
    int fields=message.EnumerateObject().Count();
    if(type.GetString()!="theme"||(fields!=2&&fields!=3)||!message.TryGetProperty("theme",out var theme)||theme.ValueKind!=JsonValueKind.String)throw new InvalidDataException();
    string style="codex";
    if(fields==3){if(!message.TryGetProperty("visualStyle",out var visual)||visual.ValueKind!=JsonValueKind.String)throw new InvalidDataException();style=visual.GetString()!;if(style!="codex"&&style!="claude")throw new InvalidDataException();}
    string? value=theme.GetString();if(value!="light"&&value!="dark")throw new InvalidDataException();
    if(closing||IsDisposed)return;
    SetCaptionTheme(value=="light",style);loading.BackColor=BackColor;loading.ForeColor=ForeColor;
   }
  }catch(OperationCanceledException){}catch{
   if(!closing&&!IsDisposed){ShowFailure("本地界面通信已中断。请关闭并重新打开应用；未自动重发任务。");await StopBackendAsync();}
  }
 }
 ToolStripMenuItem? fileMenu,viewMenu;
 void BuildCaptionMenu(){
  var file=new ToolStripMenuItem("文件(&F)"){AccessibleName="文件"};
  file.DropDownItems.Add("新聊天",null,async(_,_)=>await ClickWebAsync("new-thread"));
  file.DropDownItems.Add("打开项目…",null,async(_,_)=>await ClickWebAsync("add-project"));
  file.DropDownItems.Add("设置…",null,async(_,_)=>await ClickWebAsync("settings"));
  file.DropDownItems.Add(new ToolStripSeparator());file.DropDownItems.Add("退出",null,(_,_)=>Close());

  var display=new ToolStripMenuItem("视图(&V)"){AccessibleName="视图"};
  // Stable element IDs keep the native menu independent of translated web labels.
  foreach(var (label,target) in new[]{("对话","rail-home"),("用量与性能","rail-usage"),("账户","rail-account"),("终端与 Git","rail-terminal"),("工具活动","toggle-details"),("DSH 子代理","rail-dsh"),("设置","rail-settings")}){var id=target;display.DropDownItems.Add(label,null,async(_,_)=>await ClickWebAsync(id));}
  var help=new ToolStripMenuItem("帮助(&H)"){AccessibleName="帮助"};help.Click+=async(_,_)=>await ClickWebAsync("menu-help");
  fileMenu=file;viewMenu=display;
  CaptionMenu.Items.AddRange(new ToolStripItem[]{file,display,help});
  CaptionMenu.MenuDeactivate+=(_,_)=>{if(!IsDisposed&&IsHandleCreated)BeginInvoke((Action)(()=>{if(!closing&&Form.ActiveForm==this&&!file.DropDown.Visible&&!display.DropDown.Visible)view.Focus();}));};
  SetCaptionTheme(false);RefreshCaptionLayout();
 }
 protected override bool ProcessCmdKey(ref Message msg,Keys keyData){
  if(keyData==Keys.F10){fileMenu?.Select();CaptionMenu.Focus();return true;}
  if(keyData==(Keys.Alt|Keys.F)||keyData==(Keys.Alt|Keys.V)){
   var submenu=keyData==(Keys.Alt|Keys.F)?fileMenu:viewMenu;submenu?.Select();submenu?.ShowDropDown();return true;
  }
  if(keyData==(Keys.Alt|Keys.H)){_ = ClickWebAsync("menu-help");return true;}
  if(keyData==(Keys.Alt|Keys.E)){view.Focus();return true;} // Editing uses the focused WebView's normal Ctrl shortcuts.
  return base.ProcessCmdKey(ref msg,keyData);
 }
 async Task ClickWebAsync(string id){if(closing||view.CoreWebView2==null)return;try{await view.CoreWebView2.ExecuteScriptAsync($"document.getElementById({JsonSerializer.Serialize(id)})?.click()");}catch{}}
 bool IsOwn(string value)=>Uri.TryCreate(value,UriKind.Absolute,out var uri)&&origin!=null&&uri.Scheme==origin.Scheme&&uri.Host==origin.Host&&uri.Port==origin.Port&&uri.UserInfo=="";
 void QueueExternal(string value){
  if(closing||IsDisposed||!IsHandleCreated)return;
  BeginInvoke((Action)(()=>{if(!closing&&!IsDisposed)OpenExternal(value);}));
 }
 void OpenExternal(string value){
  if(!Uri.TryCreate(value,UriKind.Absolute,out var uri)||uri.Scheme!="https"||uri.UserInfo!=""||uri.IsLoopback)return;
  if(MessageBox.Show(this,"在系统浏览器打开以下完整外部链接？地址中的查询参数将发送给该站点。\n"+uri.AbsoluteUri,"打开外部链接",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes)return;
  try{Process.Start(new ProcessStartInfo(uri.AbsoluteUri){UseShellExecute=true});}catch{MessageBox.Show(this,"无法打开系统浏览器。","Codex Light");}
 }
 async Task PickFolderAsync(string requestId){
  if(closing)return;
  RestoreFromTray();
  using var picker=new FolderBrowserDialog{Description="选择项目工作目录",UseDescriptionForTitle=true,ShowNewFolderButton=false};
  string? path=picker.ShowDialog(this)==DialogResult.OK?picker.SelectedPath:null;
  if(path!=null&&(path.Length==0||path.Length>4096||!Path.IsPathFullyQualified(path)||path.Contains('\0')))throw new InvalidDataException("Invalid folder selection");
  await WriteHostAsync(JsonSerializer.Serialize(new{action="folderPicked",requestId,path}));
 }
 async Task LaunchInstallerAsync(string requestId,string installerPath,string sha256){
  if(closing)return;
  string? error=null;
  try{AppUpdateLauncher.Launch(installerPath,sha256);}
  catch(AppUpdateLaunchUnknownException){error="APP_UPDATE_LAUNCH_UNKNOWN";}
  catch{error="APP_UPDATE_NOT_EXECUTED";} // No exception paths or local details cross the protocol.
  await WriteHostAsync(JsonSerializer.Serialize(new{action="installerLaunched",requestId,error}));
 }
 async Task WriteHostAsync(string message){
  await hostWrites.WaitAsync();
  try{if(backend==null||backend.HasExited)throw new IOException("Local backend unavailable");await backend.StandardInput.WriteLineAsync(message);await backend.StandardInput.FlushAsync();}
  finally{hostWrites.Release();}
 }
 public void RestoreFromTray(){
  if(closing||IsDisposed)return;
  Show();if(WindowState==FormWindowState.Minimized)WindowState=placement.WasMaximized?FormWindowState.Maximized:FormWindowState.Normal;
  Activate();if(tray!=null)tray.Visible=false;
 }
 void ShowFailure(string message){
  if(closing||IsDisposed||failed)return;
  failed=true;loading.Text=message;loading.Show();loading.BringToFront();
  if(tray?.Visible==true)RestoreFromTray();
 }
 void MoveToTray(){
  placement.Capture();placement.Save();
  if(failed){RestoreFromTray();return;}
  if(backend==null||backend.HasExited){ShowFailure("本地后台未运行。请关闭并重新打开应用；窗口将保持打开。");return;}
  try{
   if(tray==null){
    trayMenu=new ContextMenuStrip();trayMenu.Items.Add("打开窗口",null,(_,_)=>RestoreFromTray());trayMenu.Items.Add(new ToolStripSeparator());
    trayMenu.Items.Add("退出",null,(_,_)=>{exitRequested=true;Close();});
    trayIcon=(Icon)(Icon??SystemIcons.Application).Clone();
    tray=new NotifyIcon{Text="Codex Light",Icon=trayIcon,ContextMenuStrip=trayMenu};tray.DoubleClick+=(_,_)=>RestoreFromTray();
   }
   tray.Visible=true;
   if(!tray.Visible)throw new InvalidOperationException("Tray icon unavailable");
   Hide();
  }catch{RestoreFromTray();MessageBox.Show(this,"无法显示系统托盘图标，窗口将保持打开。","Codex Light",MessageBoxButtons.OK,MessageBoxIcon.Error);}
 }
 void DisposeTray(){if(tray!=null){tray.Visible=false;tray.Dispose();tray=null;}trayMenu?.Dispose();trayMenu=null;trayIcon?.Dispose();trayIcon=null;}
 protected override void WndProc(ref Message message){
  sessionEnd.Observe(message.Msg,message.WParam);
  // Form raises FormClosing during QUERY, then disposes only on END(TRUE).
  // Leave disposal to that confirmed path, so END(FALSE) remains usable.
  base.WndProc(ref message);
 }
 async void OnClosing(object? sender,FormClosingEventArgs e){
  placement.Capture();placement.Save();
  if(allowClose)return;
  if(sessionEnd.DeferCleanup(e.CloseReason)||e.CloseReason==CloseReason.TaskManagerClosing)return;
  e.Cancel=true;if(closing||choosingClose)return;
  if(!exitRequested&&e.CloseReason==CloseReason.UserClosing){
   choosingClose=true;CloseChoice choice;
   try{using var dialog=new CloseChoiceDialog(BackColor,ForeColor,Font);dialog.ShowDialog(this);choice=dialog.Choice;}finally{choosingClose=false;}
   if(closing||IsDisposed)return;
   if(choice==CloseChoice.Cancel)return;
   if(choice==CloseChoice.Tray){MoveToTray();return;}
  }
  closing=true;Enabled=false;await StopBackendAsync();DisposeTray();view.Dispose();
  await CleanupProfileAsync();
  allowClose=true;if(!IsDisposed)Close();
 }
 Task StopBackendAsync()=>stopTask??=StopBackendCoreAsync();
 async Task CleanupProfileAsync(){
  for(int i=0;i<5;i++){
   try{if(Directory.Exists(profile))Directory.Delete(profile,true);return;}
   catch(IOException){await Task.Delay(200);}catch(UnauthorizedAccessException){await Task.Delay(200);}
  }
 }
 async Task StopBackendCoreAsync(){
  hostMessages.Cancel();
  // Bound the entire graceful path, including a stalled stdin write.
  try{await GracefulShutdownAsync().WaitAsync(TimeSpan.FromSeconds(5));}catch{}
  ReleaseBackend();
 }
 async Task GracefulShutdownAsync(){
  var process=backend;if(process==null||process.HasExited)return;
  await WriteHostAsync("{\"action\":\"shutdown\"}");process.StandardInput.Close();await process.WaitForExitAsync();
 }
 void ReleaseBackend(){
  job?.Dispose();job=null;
  if(backend!=null){try{if(!backend.HasExited)backend.Kill(true);}catch{}backend.Dispose();backend=null;}
 }
 protected override void Dispose(bool disposing){
  if(disposing&&!resourcesDisposed){resourcesDisposed=true;placement?.Save();placement?.Dispose();closing=true;hostMessages.Cancel();ReleaseBackend();DisposeTray();hostMessages.Dispose();hostWrites.Dispose();}
  base.Dispose(disposing);
 }
 static async Task<string> ReadBoundedLineAsync(StreamReader reader,CancellationToken cancellation){var line=new System.Text.StringBuilder();var buffer=new char[1];while(line.Length<8192){int count=await reader.ReadAsync(buffer.AsMemory(),cancellation);if(count==0)throw new EndOfStreamException();if(buffer[0]=='\n')return line.ToString();line.Append(buffer[0]);}throw new InvalidDataException("Backend handshake oversized");}
}
