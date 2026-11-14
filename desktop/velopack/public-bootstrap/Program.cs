using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Drawing;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
namespace CodexLight.PublicSetup {
 internal static class Program {
  [STAThread] static void Main(){Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);using(var gate=new Mutex(true,"CodexLight.PublicSetup."+WindowsIdentity.GetCurrent().User!.Value,out bool first)){if(!first){MessageBox.Show("安装窗口已经打开，请回到原窗口继续。","Codex Light");return;}try{Application.Run(new SetupWindow());}finally{gate.ReleaseMutex();}}}
 }
 internal sealed class SetupWindow:Form {
  readonly Label title=new Label{Text="准备更新 Codex Light",AutoSize=true,Font=new Font("Microsoft YaHei UI",18,FontStyle.Bold)};
  readonly Label detail=new Label{Dock=DockStyle.Fill,AutoEllipsis=false,Text="自动识别已有安装。旧版将先保留，待新版健康检查通过后再切换。不会修改 Codex 配置或账号。"};
  readonly CheckBox consent=new CheckBox{Text="我已保存工作并结束所有任务，允许安装并自动替换旧版",AutoSize=true};
  readonly Button start=new Button{Text="开始",AutoSize=true,MinimumSize=new Size(104,38)};
  readonly Button close=new Button{Text="取消",AutoSize=true,MinimumSize=new Size(88,38)};
  readonly ProgressBar bar=new ProgressBar{Dock=DockStyle.Fill,Height=4,Style=ProgressBarStyle.Marquee,Visible=false};
  string workerError=""; bool busy,waitingForExit; readonly CancellationTokenSource cancellation=new CancellationTokenSource(); string? extracted;
  internal SetupWindow(){Text="Codex Light";Font=new Font("Microsoft YaHei UI",10);AutoScaleMode=AutoScaleMode.Dpi;ClientSize=new Size(620,360);MinimumSize=new Size(600,380);StartPosition=FormStartPosition.CenterScreen;BackColor=Color.FromArgb(250,250,250);
   var layout=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(28),ColumnCount=1,RowCount=5};layout.RowStyles.Add(new RowStyle(SizeType.Absolute,54));layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,12));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,44));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,46));
   layout.Controls.Add(title);layout.Controls.Add(detail);layout.Controls.Add(bar);layout.Controls.Add(consent);var actions=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.RightToLeft};actions.Controls.Add(start);actions.Controls.Add(close);layout.Controls.Add(actions);Controls.Add(layout);AcceptButton=start;CancelButton=close;
   start.Click+=async(_,__)=>await Run();close.Click+=(_,__)=>{if(waitingForExit)cancellation.Cancel();else Close();};FormClosing+=(_,e)=>{if(waitingForExit){cancellation.Cancel();e.Cancel=true;}else if(busy){e.Cancel=true;detail.Text="安装或健康检查进行中，请等待完成。不会强制结束任何任务。";}};
  }
  void Progress(string text){if(IsDisposed)return;if(InvokeRequired){BeginInvoke(new Action<string>(Progress),text);return;}detail.Text=text;}
  async Task Run(){if(!consent.Checked){detail.Text="请先保存工作并结束任务，再勾选确认。安装器不会强制终止应用或任务。";consent.Focus();return;}busy=true;start.Enabled=false;close.Enabled=false;consent.Enabled=false;bar.Visible=true;
   try{var route=Detect();if(route==Route.Blocked)throw new IOException("检测到不完整、冲突或未知安装，未开始安装。旧版和数据保持不动，请保留现场。");if(route==Route.Velopack)throw new IOException("当前已经是新版安装格式。请在应用内使用检查更新，避免绕过任务保护。");
    if(route==Route.Migrate){waitingForExit=true;close.Enabled=true;Progress("请正常退出旧版 Codex Light（包括托盘），完成或停止其中任务。此窗口会在退出后自动继续，不需要再次打开安装包。");while(LegacyRunning()){await Task.Delay(500,cancellation.Token);}cancellation.Token.ThrowIfCancellationRequested();waitingForExit=false;close.Enabled=false;}
    Progress("正在校验并准备安装文件…");extracted=await Task.Run(()=>Extract());
    string exe=Path.Combine(extracted,route==Route.Migrate?@"worker\MigrationBootstrap.exe":@"fresh\CodexLight-Install.exe");
    if(route==Route.Migrate){Progress("正在备份旧版、安装新版并检查健康状态。全部通过后自动接管快捷方式。失败会保留恢复材料。");var code=await Task.Run(()=>RunWorker(exe,extracted));if(code!=0)throw new IOException("自动迁移未完成（"+code+"）。\n"+workerError+"\n诊断和恢复材料："+extracted);title.Text="更新完成";detail.Text="新版已安装，健康检查与数据完整性检查通过，旧版已退出安装登记。正在打开 Codex Light。";
     Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),@"CodexLightDesktop\Codex Light.exe")){UseShellExecute=true});
    }else{Progress("已确认是首次安装。正在打开依赖检查与安装界面…");using(var p=Process.Start(new ProcessStartInfo(exe){UseShellExecute=true})??throw new IOException("无法启动安装向导")){await Task.Run(()=>p.WaitForExit());if(p.ExitCode!=0)throw new IOException("安装向导返回 "+p.ExitCode);}title.Text="安装向导已退出";detail.Text="请以安装向导的结果为准。关闭向导或取消安装不代表安装成功。";}
   }catch(OperationCanceledException){title.Text="已取消";detail.Text="尚未启动迁移，旧版保持不变。";}catch(Exception e){title.Text="未完成更新";detail.Text=e.Message+"\n不会自动重试或绕过系统安全限制。";}
   finally{waitingForExit=false;busy=false;bar.Visible=false;close.Enabled=true;close.Text="关闭";close.Focus();}
  }
  static bool LegacyRunning(){string old=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),@"Programs\CodexLight")+Path.DirectorySeparatorChar;foreach(var process in Process.GetProcessesByName("CodexLight"))using(process){try{if(process.MainModule?.FileName?.StartsWith(old,StringComparison.OrdinalIgnoreCase)==true)return true;}catch(System.ComponentModel.Win32Exception){throw new IOException("无法确认旧程序的进程身份，请正常退出后重新安装。");}catch(InvalidOperationException){}}return false;}
  static Route Detect(){string local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);int count=0;for(int i=0;i<2;i++){uint code=MsiEnumRelatedProducts("{C63D113F-36E4-46F6-B635-F1CE57BD166E}",0,i,new StringBuilder(39));if(code==259)break;if(code!=0){count=-1;break;}count++;}
   bool registered=false,unknown=false;foreach(var hive in new[]{RegistryHive.CurrentUser,RegistryHive.LocalMachine})foreach(var view in new[]{RegistryView.Registry32,RegistryView.Registry64})using(var root=RegistryKey.OpenBaseKey(hive,view))using(var uninstall=root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall")){if(uninstall==null)continue;foreach(var key in uninstall.GetSubKeyNames())using(var item=uninstall.OpenSubKey(key)){string name=item?.GetValue("DisplayName") as string??"";if(key=="CodexLightDesktop")registered=true;else if(name.StartsWith("Codex Light",StringComparison.OrdinalIgnoreCase)&&count==0)unknown=true;}}
   return Routing.Choose(count,Directory.Exists(Path.Combine(local,@"Programs\CodexLight")),Directory.Exists(Path.Combine(local,"CodexLightDesktop")),registered,unknown,Directory.Exists(Path.Combine(local,"CodexLight")));
  }
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiEnumRelatedProducts(string code,int reserved,int index,StringBuilder product);
  static Stream Resource(string name)=>Assembly.GetExecutingAssembly().GetManifestResourceStream(name)??throw new IOException("缺少安装资源");
  static void Plain(string path){for(string? p=Path.GetFullPath(path);p!=null;p=Path.GetDirectoryName(p))if((File.Exists(p)||Directory.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("不支持重解析目录");}
  static string Extract(){string expected;using(var text=new StreamReader(Resource("Payload.sha256")))expected=text.ReadToEnd().Trim();if(expected.Length!=64||!expected.All(Uri.IsHexDigit))throw new IOException("安装资源哈希无效");
   using(var input=Resource("Payload.zip")){using(var sha=SHA256.Create())if(BitConverter.ToString(sha.ComputeHash(input)).Replace("-","").ToLowerInvariant()!=expected.ToLowerInvariant())throw new IOException("安装资源校验失败");input.Position=0;
    string root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLightMigration","bootstrap-"+Guid.NewGuid().ToString("N"));Plain(root);Directory.CreateDirectory(root);using(var archive=new ZipArchive(input,ZipArchiveMode.Read)){long total=0;var seen=new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);foreach(var entry in archive.Entries){string name=entry.FullName;if(name.EndsWith("/"))continue;if(name.Contains(":")||name.Contains("\\")||name.Split('/').Any(x=>x==""||x=="."||x==".."||x.EndsWith(".")||x.EndsWith(" "))||!seen.Add(name))throw new IOException("安装资源路径无效");total=checked(total+entry.Length);if(total>4L*1024*1024*1024)throw new IOException("安装资源超出预算");string target=Path.GetFullPath(Path.Combine(root,name));if(!target.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new IOException("安装路径越界");Plain(target);Directory.CreateDirectory(Path.GetDirectoryName(target)!);using(var source=entry.Open())using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None))source.CopyTo(output);}}return root;}
  }
  int RunWorker(string exe,string root){var info=new ProcessStartInfo(exe,"--install \""+root+"\""){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,RedirectStandardOutput=true,RedirectStandardError=true};using(var process=Process.Start(info)??throw new IOException("迁移助手未启动")){var output=Drain(process.StandardOutput);var error=Drain(process.StandardError);process.WaitForExit();Task.WaitAll(output,error);File.WriteAllText(Path.Combine(root,"bootstrap.log"),output.Result+"\n"+error.Result,Encoding.UTF8);workerError=error.Result.Length>650?error.Result.Substring(0,650):error.Result;return process.ExitCode;}}
  static async Task<string> Drain(StreamReader stream){var text=new StringBuilder();var buffer=new char[4096];int n;while((n=await stream.ReadAsync(buffer,0,buffer.Length))>0){int keep=Math.Min(n,Math.Max(0,131072-text.Length));text.Append(buffer,0,keep);}return text.ToString();}
 }
}
