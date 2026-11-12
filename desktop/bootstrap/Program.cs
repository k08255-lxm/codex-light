using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Runtime.Serialization.Json;
using System.Windows.Forms;
using Microsoft.Win32;
namespace CodexLight.Bootstrap {
 internal static class ErrorDetails {
  // Local diagnostics only: no stack, environment dump or arbitrary exception.Data.
  public static string Format(Exception error){
   var lines=new List<string>();Exception? current=error;
   for(int depth=0;current!=null&&depth<3;depth++,current=current.InnerException){
    string message=System.Text.RegularExpressions.Regex.Replace(current.Message??"",@"https?://[^\s<>""']+",match=>{
     if(!Uri.TryCreate(match.Value,UriKind.Absolute,out var uri))return "[URL]";
     return uri.Scheme+"://"+uri.Host+uri.AbsolutePath;
    });
    message=message.Replace("\r"," ").Replace("\n"," ");if(message.Length>800)message=message.Substring(0,800)+"…";
    lines.Add((depth==0?"":"原因 "+depth+"：")+current.GetType().Name+" (0x"+current.HResult.ToString("X8")+")："+message);
   }
   return string.Join(Environment.NewLine,lines);
  }
 }
 internal static class Program {
  [STAThread]static void Main(string[] args){Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
#if CHECK_ONLY
   Application.Run(new BootstrapForm(true));
#else
   if(args.Any(x=>x.Equals("/uninstall",StringComparison.OrdinalIgnoreCase))||string.Equals(Path.GetFileName(Assembly.GetExecutingAssembly().Location),"Uninstall.exe",StringComparison.OrdinalIgnoreCase)){
    if(MessageBox.Show("仅删除本安装包中未修改的程序文件，保留用户数据和共享运行时。继续？","卸载 Codex Light",MessageBoxButtons.YesNo,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)==DialogResult.Yes){try{MessageBox.Show(PayloadInstaller.Uninstall());}catch(Exception e){MessageBox.Show("卸载已停止："+ErrorDetails.Format(e));}}return;
   }
   Application.Run(new BootstrapForm(args.Any(x=>x.Equals("/check",StringComparison.OrdinalIgnoreCase))));
#endif
}
 }
 internal sealed class BootstrapForm:Form {
  readonly TextBox status=new TextBox{Multiline=true,ReadOnly=true,Dock=DockStyle.Fill,ScrollBars=ScrollBars.Vertical};
  readonly Button check=new Button{Text="重新检查",AutoSize=true};readonly Button install=new Button{Text="安装缺少的依赖…",AutoSize=true,Enabled=false};readonly Button quit=new Button{Text="关闭",AutoSize=true};
  readonly Button installApp=new Button{Text="安装 Codex Light…",AutoSize=true,Enabled=false};
  readonly Button maintainApp=new Button{Text="升级 / 修复 / 恢复…",AutoSize=true};
  readonly Button openApp=new Button{Text="打开 Codex Light",AutoSize=true,Visible=false};string? installedPath;
  readonly Button cancelDownload=new Button{Text="取消下载/准备",AutoSize=true,Visible=false};CancellationTokenSource? operationCancellation;
  readonly bool checkOnly;bool busy;List<DependencyState> states=new List<DependencyState>();
  public BootstrapForm(bool checkOnly){this.checkOnly=checkOnly;install.Visible=!checkOnly;installApp.Visible=!checkOnly&&PayloadInstaller.Available;maintainApp.Visible=!checkOnly&&PayloadInstaller.Available;Text=checkOnly?"Codex Light · 只读环境检查":"Codex Light · 运行环境";Size=new Size(760,390);MinimumSize=new Size(600,300);StartPosition=FormStartPosition.CenterScreen;
   var actions=new FlowLayoutPanel{Dock=DockStyle.Bottom,Height=90,Padding=new Padding(10),WrapContents=true};actions.Controls.AddRange(new Control[]{check,install,installApp,maintainApp,openApp,cancelDownload,quit});Controls.Add(status);Controls.Add(actions);
   maintainApp.Click+=async(_,__)=>{if(busy)return;busy=true;openApp.Enabled=false;maintainApp.Enabled=check.Enabled=install.Enabled=installApp.Enabled=false;try{await MaintenanceUi.Run(this,message=>status.AppendText(Environment.NewLine+message));}finally{busy=false;openApp.Enabled=installedPath!=null;maintainApp.Enabled=check.Enabled=true;install.Enabled=!checkOnly&&states.Any(x=>!x.Compatible);installApp.Enabled=!checkOnly&&PayloadInstaller.Available&&states.Count==3&&states.All(x=>x.Compatible);}};
   cancelDownload.Click+=(_,__)=>{operationCancellation?.Cancel();cancelDownload.Enabled=false;status.AppendText(Environment.NewLine+"已请求取消，不会启动待安装文件。等待当前验证阶段结束…");};openApp.Click+=(_,__)=>{if(installedPath==null)return;try{Process.Start(new ProcessStartInfo(Path.Combine(installedPath,"CodexLight.exe")){UseShellExecute=true,WorkingDirectory=installedPath});}catch(Exception e){status.AppendText(Environment.NewLine+"打开失败："+ErrorDetails.Format(e));}};installApp.Click+=async(_,__)=>await InstallAppAsync();check.Click+=async(_,__)=>await CheckAsync();install.Click+=async(_,__)=>await InstallAsync();quit.Click+=(_,__)=>Close();Shown+=async(_,__)=>await CheckAsync();
   FormClosing+=(_,e)=>{if(busy){e.Cancel=true;if(cancelDownload.Visible&&cancelDownload.Enabled){operationCancellation?.Cancel();cancelDownload.Enabled=false;status.AppendText(Environment.NewLine+"已请求取消下载/准备，完成清理后可关闭。");}else MessageBox.Show(this,"正在检查、复制或等待官方安装程序。官方安装中请先在其界面取消或完成。","请稍候");}};
  }
  async System.Threading.Tasks.Task CheckAsync(){busy=true;check.Enabled=install.Enabled=installApp.Enabled=false;status.Text="正在读取本机运行环境，不联网、不安装…";
   try{states=await System.Threading.Tasks.Task.Run(()=>Detection.Read());ShowStates();}catch(Exception e){status.Text="检查失败："+ErrorDetails.Format(e);states.Clear();}finally{cancelDownload.Visible=false;operationCancellation=null;busy=false;check.Enabled=true;install.Enabled=!checkOnly&&states.Any(x=>!x.Compatible);installApp.Enabled=!checkOnly&&PayloadInstaller.Available&&states.Count==3&&states.All(x=>x.Compatible);}}
  void ShowStates(){status.Text=string.Join(Environment.NewLine+Environment.NewLine,states.Select(x=>x.Name+"："+(x.Compatible?"复用已安装版本":"缺少 / 不兼容")+Environment.NewLine+x.Detail))+Environment.NewLine+Environment.NewLine+(checkOnly?"只读模式：未联网，未下载或安装。":"只安装缺少的依赖；每项先确认，再显示官方安装界面。")+Environment.NewLine+"此引导程序复用 Windows 自带的 .NET Framework 4.8，不需要先安装 .NET 10。";}
  async System.Threading.Tasks.Task InstallAppAsync(){
   using(var dialog=new FolderBrowserDialog{Description="选择空的 Codex Light 安装目录；不会覆盖已有文件",SelectedPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","CodexLight"),ShowNewFolderButton=true}){
    if(dialog.ShowDialog(this)!=DialogResult.OK)return;
    if(MessageBox.Show(this,"核验并安装到：\n"+dialog.SelectedPath+"\n不创建桌面快捷方式，不自动运行模型任务。","确认安装软件",MessageBoxButtons.YesNo,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)!=DialogResult.Yes)return;
    busy=true;check.Enabled=install.Enabled=installApp.Enabled=false;
    try{await System.Threading.Tasks.Task.Run(()=>PayloadInstaller.Install(dialog.SelectedPath));installedPath=dialog.SelectedPath;openApp.Visible=true;status.AppendText(Environment.NewLine+"软件安装完成："+installedPath+Environment.NewLine+"点击“打开 Codex Light”启动，或在此目录运行 CodexLight.exe。没有自动启动程序或模型。");}catch(Exception e){status.AppendText(Environment.NewLine+"软件安装停止："+ErrorDetails.Format(e)+"；不会覆盖已有用户文件。若错误提示临时目录清理失败，请检查该临时目录。");}finally{busy=false;check.Enabled=true;installApp.Enabled=true;}
   }
  }
  async System.Threading.Tasks.Task InstallAsync(){
   busy=true;check.Enabled=install.Enabled=installApp.Enabled=false;
   try{foreach(var dependency in states.Where(x=>!x.Compatible).ToArray()){
    if(MessageBox.Show(this,"下载并打开官方“"+dependency.Name+"”安装程序？\n将核验锁定哈希与 Windows 签名。请自行审阅安装选项、许可及 UAC；无需选择附加开发工具。","确认安装",MessageBoxButtons.YesNo,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)!=DialogResult.Yes)break;
    status.AppendText(Environment.NewLine+"开始："+dependency.Name);
    using(operationCancellation=new CancellationTokenSource()){await DependencyInstaller.Install(dependency.Key,message=>status.AppendText(Environment.NewLine+message),operationCancellation.Token,allowed=>{cancelDownload.Visible=allowed;cancelDownload.Enabled=allowed;});}operationCancellation=null;
    states=await System.Threading.Tasks.Task.Run(()=>Detection.Read());if(!states.Single(x=>x.Key==dependency.Key).Compatible)throw new InvalidOperationException(dependency.Name+"安装后检查未通过。可能需要重启或已取消；不会自动重试。");
   }ShowStates();}catch(Exception e){status.AppendText(Environment.NewLine+"已停止："+ErrorDetails.Format(e)+Environment.NewLine+"已完成的依赖安装不会自动回滚。");}finally{cancelDownload.Visible=false;operationCancellation=null;busy=false;check.Enabled=true;install.Enabled=!checkOnly&&states.Any(x=>!x.Compatible);installApp.Enabled=!checkOnly&&PayloadInstaller.Available&&states.Count==3&&states.All(x=>x.Compatible);}
  }
 }

}
