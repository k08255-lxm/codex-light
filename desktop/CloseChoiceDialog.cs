using System.Runtime.InteropServices;
namespace CodexLight.Desktop;
internal enum CloseChoice { Cancel, Exit, Tray }
internal sealed class CloseChoiceDialog : Form {
 public CloseChoice Choice { get; private set; }=CloseChoice.Cancel;
 readonly Font dialogFont=new("Microsoft YaHei UI",9f,FontStyle.Regular,GraphicsUnit.Point);
 public CloseChoiceDialog(Color surface,Color foreground){
  Text="关闭 Codex Light";FormBorderStyle=FormBorderStyle.FixedDialog;StartPosition=FormStartPosition.CenterParent;
  MinimizeBox=false;MaximizeBox=false;ShowInTaskbar=false;
  AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;Font=dialogFont;
  BackColor=SystemInformation.HighContrast?SystemColors.Window:surface;
  ForeColor=SystemInformation.HighContrast?SystemColors.WindowText:foreground;
  AutoSize=true;AutoSizeMode=AutoSizeMode.GrowAndShrink;
  var content=new TableLayoutPanel{AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,Dock=DockStyle.Fill,ColumnCount=1,RowCount=2,Padding=new Padding(24)};
  var message=new Label{UseCompatibleTextRendering=true,AutoSize=true,MaximumSize=new Size(480,0),Margin=new Padding(0,0,0,24),Text="退出会停止后台和正在运行的任务。\n转入托盘会保留任务，稍后可恢复窗口。"};
  var buttons=new FlowLayoutPanel{AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,FlowDirection=FlowDirection.RightToLeft,WrapContents=false,Margin=Padding.Empty,Anchor=AnchorStyles.Right};
  Button Make(string text,CloseChoice choice){
   var button=new Button{UseCompatibleTextRendering=true,Text=text,AccessibleName=text,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,MinimumSize=new Size(80,36),Padding=new Padding(14,6,14,6),Margin=new Padding(8,0,0,0),BackColor=BackColor,ForeColor=ForeColor,UseVisualStyleBackColor=false,FlatStyle=SystemInformation.HighContrast?FlatStyle.Standard:FlatStyle.Flat};
   if(!SystemInformation.HighContrast){button.FlatAppearance.BorderColor=Blend(BackColor,ForeColor,0.22f);button.FlatAppearance.MouseOverBackColor=Blend(BackColor,ForeColor,0.08f);button.FlatAppearance.MouseDownBackColor=Blend(BackColor,ForeColor,0.14f);}
   button.Click+=(_,_)=>{Choice=choice;DialogResult=choice==CloseChoice.Cancel?DialogResult.Cancel:DialogResult.OK;Close();};return button;
  }
  var cancel=Make("取消",CloseChoice.Cancel);buttons.Controls.Add(cancel);buttons.Controls.Add(Make("转入托盘",CloseChoice.Tray));buttons.Controls.Add(Make("退出并停止",CloseChoice.Exit));
  content.Controls.Add(message,0,0);content.Controls.Add(buttons,0,1);Controls.Add(content);
  CancelButton=cancel;AcceptButton=cancel;Shown+=(_,_)=>cancel.Focus();
 }
 protected override void Dispose(bool disposing){base.Dispose(disposing);if(disposing)dialogFont.Dispose();}
 static Color Blend(Color a,Color b,float ratio)=>Color.FromArgb((int)(a.R+(b.R-a.R)*ratio),(int)(a.G+(b.G-a.G)*ratio),(int)(a.B+(b.B-a.B)*ratio));
 protected override void OnHandleCreated(EventArgs e){
  base.OnHandleCreated(e);if(SystemInformation.HighContrast)return;
  try{int dark=BackColor.GetBrightness()<0.5?1:0;DwmSetWindowAttribute(Handle,20,ref dark,sizeof(int));int caption=ColorTranslator.ToWin32(BackColor),text=ColorTranslator.ToWin32(ForeColor),border=ColorTranslator.ToWin32(Blend(BackColor,ForeColor,0.22f));DwmSetWindowAttribute(Handle,34,ref border,sizeof(int));DwmSetWindowAttribute(Handle,35,ref caption,sizeof(int));DwmSetWindowAttribute(Handle,36,ref text,sizeof(int));}catch(DllNotFoundException){}catch(EntryPointNotFoundException){}
 }
 [DllImport("dwmapi.dll")]static extern int DwmSetWindowAttribute(IntPtr hwnd,int attribute,ref int value,int size);
}
