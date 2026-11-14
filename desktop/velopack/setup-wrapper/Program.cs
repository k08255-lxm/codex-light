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
  [STAThread]static void Main(){
   Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
   using(var mutex=new Mutex(true,"CodexLight.SetupWrapper."+WindowsIdentity.GetCurrent().User!.Value,out bool first)){
    if(!first){MessageBox.Show("已有安装检查窗口正在运行。请先完成或关闭该窗口。","Codex Light");return;}
    try{Application.Run(new SetupForm());}finally{mutex.ReleaseMutex();}
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
  public SetupForm(){
   Text="安装 Codex Light";Font=new Font("Microsoft YaHei UI",10);ClientSize=new Size(600,310);MinimumSize=Size;StartPosition=FormStartPosition.CenterScreen;
   var panel=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(24),ColumnCount=1,RowCount=4};panel.RowStyles.Add(new RowStyle(SizeType.Percent,100));panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
   status.Text="先检查并复用已有 Node.js 22.15+ x64（含 DSH 桥要求）与 Codex CLI；缺失项会分别询问是否安装，不会自动登录或更改 Codex 配置。\n\n此入口仅用于首次安装，不覆盖旧 MSI 或既有安装/数据。随后启动应用安装器，成功后可能自动打开新应用。\n\nVelopack 1.3.39-g8d2844f 为预发布依赖。本包尚未数字签名；遇到系统安全阻止请停止，不要绕过。";
   var buttons=new FlowLayoutPanel{AutoSize=true,Dock=DockStyle.Fill};buttons.Controls.Add(start);buttons.Controls.Add(cancel);panel.Controls.Add(status);panel.Controls.Add(consent);panel.Controls.Add(buttons);Controls.Add(panel);
   cancel.Click+=(_,__)=>cancellation.Cancel();start.Click+=async(_,__)=>await Start();
   FormClosing+=(_,e)=>{if(busy){e.Cancel=true;MessageBox.Show("操作进行中，请等待官方安装器完成或在其窗口取消。下载阶段可以使用“取消下载”。","Codex Light");}};
  }
  void Progress(string text){if(IsDisposed)return;if(InvokeRequired){BeginInvoke(new Action<string>(Progress),text);return;}status.Text=text;}
  void AllowCancel(bool value){if(InvokeRequired){BeginInvoke(new Action<bool>(AllowCancel),value);return;}cancel.Enabled=value;}
  async Task Start(){
   if(!consent.Checked){MessageBox.Show("请先保存工作、结束任务，再勾选确认。","Codex Light");return;}
   busy=true;start.Enabled=false;consent.Enabled=false;
   try{var code=await InstallFlow.Run(this);Progress(code==0?"安装器已成功退出。请确认新应用能正常使用。此结果不代表真实账号或任务已验证。":code==3010?"系统报告需要重启，已停止，尚未继续应用安装。请稍后重新检查。":code==1602?"已取消后续步骤。已经安装的依赖（如有）会保留。":"安装器返回错误 "+code+"。请保留现场并报告，不要绕过系统阻止。");}
   catch(OperationCanceledException){Progress("已取消后续步骤。已经安装的依赖（如有）会保留。");}
   catch(Exception e){Progress("已停止："+e.Message+"\n请报告提示；不要管理员重试、关闭防护或绕过安全限制。");}
   finally{busy=false;cancel.Enabled=false;verifiedLease?.Dispose();verifiedLease=null;}
  }
  internal static void Plain(string path){for(string? p=Path.GetFullPath(path);p!=null;p=Path.GetDirectoryName(p))if((File.Exists(p)||Directory.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("不支持链接/重解析目录。");}
  public void RequireFresh(){
   if(!CodexLight.Prerequisites.CliPrerequisite.NativeX64()||Environment.OSVersion.Version.Build<19041)throw new InvalidOperationException("需要 Windows 10 19041+ 或 Windows 11 x64。");
   try{using(var running=Mutex.OpenExisting("CodexLight.Desktop."+WindowsIdentity.GetCurrent().User!.Value)){bool acquired=false;try{try{acquired=running.WaitOne(0);}catch(AbandonedMutexException){acquired=true;}if(!acquired)throw new IOException("Codex Light 仍在运行，请先结束任务并正常退出。");}finally{if(acquired)running.ReleaseMutex();}}}catch(WaitHandleCannotBeOpenedException){}
   var local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
   foreach(var p in new[]{target,Path.Combine(local,"Programs","CodexLight"),Path.Combine(local,"CodexLight")}){Plain(p);if(File.Exists(p)||Directory.Exists(p))throw new IOException("检测到既有 Codex Light 安装或数据。此入口不会覆盖；请使用更新/迁移流程。");}
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
  public bool ConsentNode()=>MessageBox.Show(this,(nodeUpgradeRequired?"检测到 "+existingNode+"。核心功能支持 Node 20+，但完整 DSH 桥要求 Node 22.15+。\n继续将打开锁定版本的官方 Node.js MSI，升级现有系统 Node，可能影响其他使用 Node 的软件；请先结束相关任务。\n若不希望更改系统，请选择否，先自行准备满足要求的独立 Node 环境。":"未找到兼容的 Node.js 22.15+ x64。是否从 nodejs.org 下载并打开固定版本的官方安装器？")+"\n将验证固定哈希、Windows 数字签名与发行者。可以在官方窗口取消；拒绝或取消不会继续应用安装。","安装 Node.js 前确认",MessageBoxButtons.YesNo,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)==DialogResult.Yes;
  public Task<int> InstallNode()=>CodexLight.Bootstrap.DependencyInstaller.Install("node",Progress,cancellation.Token,AllowCancel,false);
  public async Task<NodeState> DetectCli(){Progress("正在检查 Codex CLI 版本，不会登录或调用模型。");return await Task.Run(()=>{var found=CodexLight.Prerequisites.CliPrerequisite.Detect();return found.State==CodexLight.Prerequisites.CliState.Ready?NodeState.Ready:found.State==CodexLight.Prerequisites.CliState.Missing?NodeState.Missing:NodeState.Uncertain;});}
  public bool ConsentCli()=>MessageBox.Show(this,"未找到兼容的 Codex CLI。是否从官方 registry.npmjs.org 安装锁定版本 0.169.0？\n平台包下载约 178 MiB（187 MB），展开约 492 MiB（515 MB）；临时解包还需额外空间。\n仅安装到本应用的用户工具目录，不覆盖系统 Codex、不修改 PATH 或已有配置、不自动登录。你可以取消。","安装 Codex CLI 前确认",MessageBoxButtons.YesNo,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)==DialogResult.Yes;
  public async Task<int> InstallCli(){AllowCancel(true);try{return await CodexLight.Prerequisites.CliPrerequisite.InstallAsync(new Progress<string>(Progress),cancellation.Token);}finally{AllowCancel(false);}}
  public async Task<int> RunVendor(){Progress("正在打开应用安装器。成功后可能自动打开新应用；请等待安装器结束。");cancellation.Token.ThrowIfCancellationRequested();
   var info=new ProcessStartInfo(extracted!,"--installto \""+target+"\""){UseShellExecute=true};
   using(var p=Process.Start(info)??throw new IOException("安装器未启动。")){await Task.Run(()=>p.WaitForExit());return p.ExitCode;}
  }
 }
}
