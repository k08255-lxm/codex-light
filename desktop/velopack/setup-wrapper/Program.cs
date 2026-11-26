using System;
using System.IO;
using System.Linq;
using System.Drawing;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
namespace CodexLight.SetupWrapper {
 internal static class Program {
  [STAThread]static int Main(){
   Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
   using(var mutex=new Mutex(true,"CodexLight.SetupWrapper."+WindowsIdentity.GetCurrent().User!.Value,out bool first)){
    if(!first){MessageBox.Show("已有安装检查窗口正在运行。请先完成或关闭该窗口。","码舱 CodeCang");return 1618;}
    try{using(var form=new SetupForm()){Application.Run(form);return form.ExitCode;}}finally{mutex.ReleaseMutex();}
   }
  }
 }
 internal sealed class SetupForm:Form,IInstallHost {
  readonly Label status=new Label{AutoSize=false,Dock=DockStyle.Fill};
  readonly Button start=new Button{Text="检查并安装",AutoSize=true};
  readonly Button cancel=new Button{Text="取消下载",AutoSize=true,Enabled=false};
  readonly CheckBox consent=new CheckBox{Text="我已保存工作并结束所有相关任务；确认开始实际安装",AutoSize=true};
  readonly CancellationTokenSource cancellation=new CancellationTokenSource();
  readonly string target=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLightDesktop");
  string? extracted;FileStream? verifiedLease;bool busy,nodeUpgradeRequired;string existingNode="";
  internal int ExitCode {get;private set;}=1602;
  readonly Version version=typeof(SetupForm).Assembly.GetName().Version!;
  public SetupForm(){
   Text="安装 码舱 CodeCang";Font=new Font("Microsoft YaHei UI",10);ClientSize=new Size(600,310);MinimumSize=Size;StartPosition=FormStartPosition.CenterScreen;
   var panel=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(24),ColumnCount=1,RowCount=4};panel.RowStyles.Add(new RowStyle(SizeType.Percent,100));panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
   status.Text="即将安装码舱 CodeCang v"+version.ToString(3)+"（Windows x64），包含桌面界面、本地服务和 DSH 桥。\n安装位置："+target+"\n\n向导会复用兼容的 Node.js 22.15+ x64 和 Codex CLI，缺少时分别询问。也可以稍后在应用中选择已有的 Codex CLI 或 WSL。\n\n本安装包尚未数字签名，使用 Velopack 1.3.39-g8d2844f 预发布版。";
   var buttons=new FlowLayoutPanel{AutoSize=true,Dock=DockStyle.Fill};buttons.Controls.Add(start);buttons.Controls.Add(cancel);panel.Controls.Add(status);panel.Controls.Add(consent);panel.Controls.Add(buttons);Controls.Add(panel);
   cancel.Click+=(_,__)=>cancellation.Cancel();start.Click+=async(_,__)=>await Start();
   FormClosing+=(_,e)=>{if(busy){e.Cancel=true;MessageBox.Show("操作进行中，请等待官方安装器完成或在其窗口取消。下载阶段可以使用“取消下载”。","码舱 CodeCang");}};
  }
  void Progress(string text){if(IsDisposed)return;if(InvokeRequired){BeginInvoke(new Action<string>(Progress),text);return;}status.Text=text;}
  void AllowCancel(bool value){if(InvokeRequired){BeginInvoke(new Action<bool>(AllowCancel),value);return;}cancel.Enabled=value;}
  async Task Start(){
   if(!consent.Checked){MessageBox.Show("请先保存工作、结束任务，再勾选确认。","码舱 CodeCang");return;}
   busy=true;start.Enabled=false;consent.Enabled=false;
   try{
    ExitCode=await InstallFlow.Run(this);
    if(ExitCode==0){
     var executable=Path.Combine(target,"current","CodexLight.exe");Plain(executable);
     if(!File.Exists(executable)||FileVersionInfo.GetVersionInfo(executable).FileVersion!=version.ToString())
      throw new IOException("安装程序已退出，但未在目标目录找到对应版本的码舱。");
     Progress("安装完成 · 码舱 CodeCang v"+version.ToString(3)+"\n"+target);
    }else Progress(ExitCode==3010?"系统要求重启。重启后请再次检查安装状态。":ExitCode==1602?"已取消安装。已经装好的依赖会保留。":"安装未完成，安装程序返回错误 "+ExitCode+"。");
   }
   catch(OperationCanceledException){ExitCode=1602;Progress("已取消安装。已经装好的依赖会保留。");}
   catch(Exception e){ExitCode=1;Progress("安装未完成："+e.Message);}
   finally{busy=false;cancel.Enabled=false;verifiedLease?.Dispose();verifiedLease=null;}
  }
  internal static void Plain(string path){for(string? p=Path.GetFullPath(path);p!=null;p=Path.GetDirectoryName(p))if((File.Exists(p)||Directory.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("不支持链接/重解析目录。");}
  public void RequireFresh(){
   if(!CodexLight.Prerequisites.CliPrerequisite.NativeX64()||Environment.OSVersion.Version.Build<19041)throw new InvalidOperationException("需要 Windows 10 19041+ 或 Windows 11 x64。");
   try{using(var running=Mutex.OpenExisting("CodexLight.Desktop."+WindowsIdentity.GetCurrent().User!.Value)){bool acquired=false;try{try{acquired=running.WaitOne(0);}catch(AbandonedMutexException){acquired=true;}if(!acquired)throw new IOException("码舱 CodeCang 仍在运行，请先结束任务并正常退出。");}finally{if(acquired)running.ReleaseMutex();}}}catch(WaitHandleCannotBeOpenedException){}
   var local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
   foreach(var p in new[]{target,Path.Combine(local,"Programs","CodexLight"),Path.Combine(local,"CodexLight")}){Plain(p);if(File.Exists(p)||Directory.Exists(p))throw new IOException("检测到既有 码舱 CodeCang 安装或数据。此入口不会覆盖；请使用更新/迁移流程。");}
   foreach(var hive in new[]{RegistryHive.CurrentUser,RegistryHive.LocalMachine})foreach(var view in new[]{RegistryView.Registry32,RegistryView.Registry64})using(var r=RegistryKey.OpenBaseKey(hive,view))using(var u=r.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall")){
    if(u==null)continue;foreach(var name in u.GetSubKeyNames())using(var item=u.OpenSubKey(name)){var title=item?.GetValue("DisplayName") as string;if(name=="CodexLightDesktop"||title!=null&&title.StartsWith("Codex Light",StringComparison.OrdinalIgnoreCase))throw new IOException("检测到已有安装登记，请使用更新/迁移流程。");}
   }
  }
  static Stream Resource(string name)=>Assembly.GetExecutingAssembly().GetManifestResourceStream(name)??throw new IOException("安装资源缺失。");
  public void VerifyVendor(){
   string expected;using(var reader=new StreamReader(Resource("VendorSetup.sha256")))expected=reader.ReadToEnd().Trim();
   if(expected.Length!=64||!expected.All(Uri.IsHexDigit))throw new IOException("安装器校验信息无效。");
   if(extracted==null){var dir=Path.Combine(Path.GetTempPath(),"CodexLight-SetupWrapper-"+Guid.NewGuid().ToString("N"));Plain(dir);Directory.CreateDirectory(dir);extracted=Path.Combine(dir,"VendorSetup.exe");using(var input=Resource("VendorSetup.exe"))using(var output=new FileStream(extracted,FileMode.CreateNew,FileAccess.Write,FileShare.None))input.CopyTo(output);}
   Plain(extracted);verifiedLease?.Dispose();verifiedLease=new FileStream(extracted,FileMode.Open,FileAccess.Read,FileShare.Read);
   using(var sha=SHA256.Create()){var actual=BitConverter.ToString(sha.ComputeHash(verifiedLease)).Replace("-","");if(!actual.Equals(expected,StringComparison.OrdinalIgnoreCase))throw new IOException("安装器内容校验失败，未执行。");}
  }
  public async Task<NodeState> DetectNode(){Progress("正在检查已有 Node.js；不会下载或安装。");return await Task.Run(()=>{var n=CodexLight.Prerequisites.Program.Detect(AppDomain.CurrentDomain.BaseDirectory,out var uncertain);if(n!=null){existingNode=n.Version;nodeUpgradeRequired=!InstallFlow.BridgeCompatible(n.Version);return nodeUpgradeRequired?NodeState.UpgradeRequired:NodeState.Ready;}nodeUpgradeRequired=false;return uncertain?NodeState.Uncertain:NodeState.Missing;});}
  public bool ConsentNode()=>MessageBox.Show(this,(nodeUpgradeRequired?"检测到 "+existingNode+"。核心功能支持 Node 20+，但完整 DSH 桥要求 Node 22.15+。\n继续将打开Node.js 24 LTS 最新补丁的官方 MSI，升级现有系统 Node，可能影响其他使用 Node 的软件；请先结束相关任务。\n若不希望更改系统，请选择否，先自行准备满足要求的独立 Node 环境。":"未找到兼容的 Node.js 22.15+ x64。是否从 nodejs.org 下载并打开Node.js 24 LTS 最新补丁的官方安装器？")+"\n将验证官方 SHA256、Windows 数字签名与发行者。可以在官方窗口取消；拒绝或取消不会继续应用安装。","安装 Node.js 前确认",MessageBoxButtons.YesNo,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)==DialogResult.Yes;
  public Task<int> InstallNode()=>CodexLight.Bootstrap.DependencyInstaller.Install("node",Progress,cancellation.Token,AllowCancel,false);
  public async Task<NodeState> DetectCli(){Progress("正在检查 Codex CLI 版本，不会登录或调用模型。");return await Task.Run(()=>{var found=CodexLight.Prerequisites.CliPrerequisite.Detect();return found.State==CodexLight.Prerequisites.CliState.Ready?NodeState.Ready:found.State==CodexLight.Prerequisites.CliState.Missing?NodeState.Missing:NodeState.Uncertain;});}
  public CliChoice ChooseCli(){
   var choice=MessageBox.Show(this,"未找到 Windows Codex CLI。请选择后续方式：\n\n是：从官方 registry.npmjs.org 安装固定版本 0.169.0 到本应用私有目录。下载约 178 MiB，展开约 492 MiB，不修改系统 PATH 或 Codex 配置。\n\n否：仅安装应用，稍后在设置中选择 WSL 或已有 Codex。向导不检测 WSL；安装后，码舱会自动检测运行中的发行版。检查已停止的发行版可在设置中点「完整检测 WSL」。配置完成前不能发送消息。Windows Node.js 仍是应用后端的必需环境。\n\n取消：退出安装流程。不会自动登录或调用模型。","选择 Codex 运行环境",MessageBoxButtons.YesNoCancel,MessageBoxIcon.Question,MessageBoxDefaultButton.Button3);
   return choice==DialogResult.Yes?CliChoice.InstallWindows:choice==DialogResult.No?CliChoice.ConfigureInApp:CliChoice.Cancel;
  }
  public async Task<int> InstallCli(){AllowCancel(true);try{return await CodexLight.Prerequisites.CliPrerequisite.InstallAsync(new Progress<string>(Progress),cancellation.Token);}finally{AllowCancel(false);}}
  public async Task<int> RunVendor(){Progress("正在打开应用安装器。成功后可能自动打开新应用；请等待安装器结束。");cancellation.Token.ThrowIfCancellationRequested();
   var info=new ProcessStartInfo(extracted!,"--installto \""+target+"\""){UseShellExecute=true};
   using(var p=Process.Start(info)??throw new IOException("安装器未启动。")){await Task.Run(()=>p.WaitForExit());return p.ExitCode;}
  }
 }
}
