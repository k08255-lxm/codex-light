using System;using System.IO;using System.IO.Compression;using System.Linq;using System.Text;using System.Drawing;using System.Diagnostics;using System.Security.Cryptography;using System.Security.Principal;using System.Runtime.InteropServices;using System.Threading;using System.Threading.Tasks;using System.Windows.Forms;using System.Net;using Microsoft.Win32;
namespace CodexLight.PublicSetup {
 internal static class Program { [STAThread] static int Main(){Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);using(var gate=new Mutex(true,"CodeCang.CompatRouter."+WindowsIdentity.GetCurrent().User!.Value,out bool first)){if(!first)return 1618;try{using(var window=new RouterWindow()){Application.Run(window);return window.ExitCode;}}finally{gate.ReleaseMutex();}}} }
 internal sealed class RouterWindow:Form {
  readonly Label title=new Label{Text="码舱 CodeCang · "+Pins.Version,AutoSize=true,Font=new Font("Microsoft YaHei UI",18,FontStyle.Bold)};
  readonly Label detail=new Label{Dock=DockStyle.Fill,Text="码舱桌面版 v"+Pins.Version+" · Windows x64\n\n此包包含桌面界面、本地服务和 DSH 桥。继续后会检查这台电脑，进入首次安装、更新或旧版迁移流程。",Padding=new Padding(0,12,0,12)};
  readonly Button start=new Button{Text="检查并继续",AutoSize=true,MinimumSize=new Size(104,38)},close=new Button{Text="关闭",AutoSize=true,MinimumSize=new Size(88,38)};
  readonly ProgressBar progress=new ProgressBar{Dock=DockStyle.Fill,Style=ProgressBarStyle.Marquee,Visible=false};bool busy;string legacyRoot="";internal int ExitCode{get;private set;}=1602;
  internal RouterWindow(){
   SuspendLayout();
   Text="码舱 CodeCang 更新";
   Font=new Font("Microsoft YaHei UI",10);
   AutoScaleDimensions=new SizeF(96,96);
   AutoScaleMode=AutoScaleMode.Dpi;
   ClientSize=new Size(640,330);
   MinimumSize=new Size(600,350);
   StartPosition=FormStartPosition.CenterScreen;
   var panel=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(28),ColumnCount=1,RowCount=4};
   panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
   panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
   panel.RowStyles.Add(new RowStyle(SizeType.Percent,100));
   panel.RowStyles.Add(new RowStyle(SizeType.Absolute,8));
   panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
   // Hidden controls do not reserve automatically assigned cells. Always pin the
   // action row so hiding progress cannot put the buttons in its 8px row.
   panel.Controls.Add(title,0,0);
   panel.Controls.Add(detail,0,1);
   panel.Controls.Add(progress,0,2);
   var actions=new FlowLayoutPanel{Dock=DockStyle.Fill,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,WrapContents=false,FlowDirection=FlowDirection.RightToLeft,Padding=new Padding(0,12,0,0)};
   actions.Controls.Add(start);
   actions.Controls.Add(close);
   panel.Controls.Add(actions,0,3);
   Controls.Add(panel);
   AcceptButton=start;
   CancelButton=close;
   start.Click+=async(_,__)=>await Run();
   close.Click+=(_,__)=>Close();
   FormClosing+=(_,e)=>{if(busy)e.Cancel=true;};
   ResumeLayout(true);
  }
  async Task Run(){start.Text="处理中…";busy=true;start.Enabled=false;close.Enabled=false;progress.Visible=true;try{
   var route=Detect();if(route==Route.Blocked)throw new IOException("安装状态不明确或有未完成迁移。未运行安装器，请保留恢复资料。");
   if(route==Route.Velopack){
#if REPAIR
    detail.Text="正在校验安装包。校验完成后，由你确认是否安装更新。";
    await Repair.Prepare(()=>{
     bool accepted=MessageBox.Show(this,"安装码舱 CodeCang "+Pins.Version+"？\n\n如果码舱正在运行，安装器会请求它正常退出，请先保存工作；如果已经退出，无需再次关闭。若程序仍被占用，更新会停止，不会强制结束进程。\n\n确认后将显示更新进度，只有安装及文件校验成功才会提示完成。", "安装更新",MessageBoxButtons.OKCancel,MessageBoxIcon.Information,MessageBoxDefaultButton.Button2)==DialogResult.OK;
     if(accepted)detail.Text="正在准备更新；如码舱正在运行，将请求它正常退出。";
     return accepted;
    },()=>{ExitCode=0;busy=false;Close();});
#else
    detail.Text="已使用新的安装方式。请在应用内检查更新并确认安装；此入口不会重复迁移或降级。";
#endif
    return;
   }
   bool bridge=route==Route.Migrate;detail.Text=bridge?"正在下载并验证固定 0.4.4 迁移安装器。接下来请按安装器说明保存工作并退出旧版。":"正在解包并校验 v"+Pins.Version+" 首次安装向导…";
   string cache=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexLightMigration","router-"+Guid.NewGuid().ToString("N"));Plain(cache);Directory.CreateDirectory(cache);
   string download=Path.Combine(cache,bridge?"bridge.exe":"fresh.zip");await Task.Run(()=>{if(bridge)Download(RouterPolicy.BridgeUrl,RouterPolicy.BridgeHash,download);else ExtractEmbedded(download);});
   using(var verified=VerifiedLease.Open(download,bridge?RouterPolicy.BridgeHash:Pins.FreshHash))
   using(var fresh=bridge?null:FreshLease.Extract(verified,Path.Combine(cache,"fresh"))){
   if(Detect()!=route)throw new IOException("下载期间安装状态改变；未启动安装器，请重新检查。");
   string exe=bridge?download:fresh!.Installer;
   detail.Text=bridge?"请在打开的安装器中完成迁移到 0.4.4。随后应用会自动检查新版，由您点击更新到 "+Pins.Version+"（或之后的新版本）。":"请在打开的安装向导中确认安装。";
   using(var p=Process.Start(new ProcessStartInfo(exe){UseShellExecute=true})??throw new IOException("无法打开安装器")){
    await Task.Run(()=>p.WaitForExit());
    if(p.ExitCode==1602||p.ExitCode==3010){ExitCode=p.ExitCode;title.Text=ExitCode==1602?"已取消安装":"需要重启";detail.Text=ExitCode==1602?"安装向导已取消，已经装好的依赖会保留。":"请重启 Windows，然后重新打开安装程序检查状态。";return;}
    if(p.ExitCode!=0)throw new IOException("安装程序返回错误 "+p.ExitCode+"。");
   }
   }
   ExitCode=0;title.Text=bridge?"旧版迁移向导已结束":"安装完成";detail.Text=bridge?"请在迁移后的 0.4.4 中查看最新更新提示。":"已安装码舱 CodeCang v"+Pins.Version+"。可以从开始菜单打开。";
  }catch(Exception e){ExitCode=1;title.Text="未完成";detail.Text=e.Message;}finally{busy=false;close.Enabled=true;progress.Visible=false;start.Text=ExitCode==0?"已完成":"未完成";}}
  static void Plain(string path){for(string? p=Path.GetFullPath(path);p!=null;p=Path.GetDirectoryName(p))if((File.Exists(p)||Directory.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("不支持链接目录");}
  static void ExtractEmbedded(string file){
   using(var input=typeof(RouterWindow).Assembly.GetManifestResourceStream("CodeCang.Fresh.zip")??throw new IOException("Missing embedded installer"))
   using(var output=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None)){
    if(input.Length>128L*1024*1024)throw new IOException("Embedded installer too large");input.CopyTo(output);output.Flush(true);
   }
   // VerifiedLease.Open checks the build-pinned SHA256 before extraction or execution.
  }
  static void Download(string address,string hash,string file){ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;var timer=Stopwatch.StartNew();var uri=new Uri(address);for(int redirects=0;redirects<6;redirects++){RouterPolicy.Redirect(uri);var request=(HttpWebRequest)WebRequest.Create(uri);request.AllowAutoRedirect=false;request.Timeout=30000;request.ReadWriteTimeout=30000;using(var response=(HttpWebResponse)request.GetResponse()){int status=(int)response.StatusCode;if(status>=300&&status<400){uri=new Uri(uri,response.Headers["Location"]??throw new IOException("缺少下载地址"));continue;}if(status!=200||response.ContentLength>128L*1024*1024)throw new IOException("下载响应异常");using(var input=response.GetResponseStream())using(var output=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None)){var buffer=new byte[65536];long total=0;int count;while((count=input.Read(buffer,0,buffer.Length))>0){total+=count;if(timer.Elapsed>TimeSpan.FromMinutes(5))throw new IOException("下载超时；未执行安装器");if(total>128L*1024*1024)throw new IOException("下载超出大小限制");output.Write(buffer,0,count);}output.Flush(true);}using(var input=File.OpenRead(file))using(var sha=SHA256.Create())if(BitConverter.ToString(sha.ComputeHash(input)).Replace("-","").ToLowerInvariant()!=hash)throw new IOException("安装器校验失败，未执行");return;}}throw new IOException("下载重定向过多");}
  Route Detect(){string local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);int count=0;string product="";for(int i=0;i<2;i++){var id=new StringBuilder(39);uint code=MsiEnumRelatedProducts("{C63D113F-36E4-46F6-B635-F1CE57BD166E}",0,i,id);if(code==259)break;if(code!=0){count=-1;break;}count++;product=id.ToString();}
   if(count==1){if(!Guid.TryParseExact(product,"B",out _))throw new IOException("Invalid MSI identity");uint length=32767;var location=new StringBuilder((int)length);uint result=MsiGetProductInfoEx(product,null,2,"InstallLocation",location,ref length);if(result!=0)throw new IOException("MSI InstallLocation read failed: "+result);legacyRoot=Routing.ValidateLegacyRoot(location.ToString(),Directory.Exists,File.Exists);Plain(legacyRoot);Plain(Path.Combine(legacyRoot,"CodexLight.exe"));}
   bool registered=false,unknown=false;foreach(var hive in new[]{RegistryHive.CurrentUser,RegistryHive.LocalMachine})foreach(var view in new[]{RegistryView.Registry32,RegistryView.Registry64})using(var root=RegistryKey.OpenBaseKey(hive,view))using(var uninstall=root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall")){if(uninstall==null)continue;foreach(var key in uninstall.GetSubKeyNames())using(var item=uninstall.OpenSubKey(key)){string name=item?.GetValue("DisplayName") as string??"";if(key=="CodexLightDesktop")registered=true;else if(name.StartsWith("Codex Light",StringComparison.OrdinalIgnoreCase)&&count==0)unknown=true;}}
   return Routing.Choose(count,count==1?legacyRoot.Length>0:Directory.Exists(Path.Combine(local,@"Programs\CodexLight")),Directory.Exists(Path.Combine(local,"CodexLightDesktop")),registered,unknown,Directory.Exists(Path.Combine(local,"CodexLight")));
  }
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiEnumRelatedProducts(string code,int reserved,int index,StringBuilder product);
  [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiGetProductInfoEx(string product,string? sid,uint context,string property,StringBuilder value,ref uint length);

 }
}
