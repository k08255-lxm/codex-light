namespace CodexLight.Desktop;

internal enum CloseChoice { Cancel, Exit, Tray }

internal sealed class CloseChoiceDialog : Form {
 public CloseChoice Choice { get; private set; }=CloseChoice.Cancel;
 public CloseChoiceDialog(Color surface,Color foreground,Font font){
  Text="关闭 Codex Light";FormBorderStyle=FormBorderStyle.FixedDialog;StartPosition=FormStartPosition.CenterParent;
  MinimizeBox=false;MaximizeBox=false;ShowInTaskbar=false;AutoScaleMode=AutoScaleMode.Dpi;
  Font=font;
  BackColor=SystemInformation.HighContrast?SystemColors.Window:surface;
  ForeColor=SystemInformation.HighContrast?SystemColors.WindowText:foreground;
  ClientSize=new Size(468,152);Padding=new Padding(20);
  var message=new Label{AutoSize=false,Dock=DockStyle.Top,Height=62,Text="请选择关闭方式。退出会停止本应用后台和正在运行的任务；转入托盘后任务继续运行。"};
  var buttons=new FlowLayoutPanel{Dock=DockStyle.Bottom,Height=36,FlowDirection=FlowDirection.RightToLeft,WrapContents=false};
  Button Make(string text,CloseChoice choice,int width){var button=new Button{Text=text,AutoSize=false,Width=width,Height=32,BackColor=BackColor,ForeColor=ForeColor,UseVisualStyleBackColor=false,FlatStyle=SystemInformation.HighContrast?FlatStyle.Standard:FlatStyle.Flat};button.Click+=(_,_)=>{Choice=choice;DialogResult=choice==CloseChoice.Cancel?DialogResult.Cancel:DialogResult.OK;Close();};return button;}
  var cancel=Make("取消",CloseChoice.Cancel,70);buttons.Controls.Add(cancel);buttons.Controls.Add(Make("转入托盘继续运行",CloseChoice.Tray,142));buttons.Controls.Add(Make("退出并停止后台",CloseChoice.Exit,126));
  Controls.Add(message);Controls.Add(buttons);CancelButton=cancel;AcceptButton=cancel;Shown+=(_,_)=>cancel.Focus();
 }
}
