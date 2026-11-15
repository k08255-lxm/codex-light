using CodexLight.Desktop;
using System.Drawing.Imaging;
internal static class Tests {
 static int checks;
 static void Check(bool result,string message){checks++;if(!result)throw new Exception(message);}
 static IEnumerable<Control> Descendants(Control control){foreach(Control child in control.Controls){yield return child;foreach(var item in Descendants(child))yield return item;}}
 [STAThread]static void Main(string[] args){
  Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);Application.EnableVisualStyles();
  CheckCaptionCommands();
  if(args.Contains("--native-visible")){
   var folder=Path.Combine(AppContext.BaseDirectory,"visible-previews");Directory.CreateDirectory(folder);
   using var preview=new CaptionProbe{Text="CodeCang test - no account or backend",AllowCommands=true,Size=new Size(880,540),StartPosition=FormStartPosition.CenterScreen};
   preview.Show();preview.Activate();Application.DoEvents();
   void Capture(string name){Application.DoEvents();Thread.Sleep(150);using var bitmap=new Bitmap(preview.Width,preview.Height);using(var graphics=Graphics.FromImage(bitmap)){var dc=graphics.GetHdc();try{Check(PrintWindow(preview.Handle,dc,2),"visible native render");}finally{graphics.ReleaseHdc(dc);}}Check(bitmap.GetPixel(100,30).ToArgb()==bitmap.GetPixel(100,150).ToArgb(),"caption stays flat without legacy title on "+name);bitmap.Save(Path.Combine(folder,name+".png"),ImageFormat.Png);}
   Capture("normal-dark");
   Check(DwmGetWindowAttribute(preview.Handle,5,out var buttons,System.Runtime.InteropServices.Marshal.SizeOf<NativeRect>())==0,"DWM caption button bounds");
   Console.WriteLine($"DWM button bounds: {buttons.Left},{buttons.Top} to {buttons.Right},{buttons.Bottom}; DPI={preview.DeviceDpi}");
   GetWindowRect(preview.Handle,out var wr);
   int y=wr.Top+(buttons.Top+buttons.Bottom)/2;
   foreach(var pair in new[]{(buttons.Right-buttons.Width/6,20),(buttons.Right-buttons.Width/2,9),(buttons.Left+buttons.Width/6,8)}){
    var xy=(IntPtr)(((y&0xffff)<<16)|((wr.Left+pair.Item1)&0xffff));int hit=(int)SendMessage(preview.Handle,0x84,IntPtr.Zero,xy);Console.WriteLine($"caption hit={hit} expected={pair.Item2}");Check(hit==pair.Item2,"native caption hit test");
   }
        using(var popup=new ContextMenuStrip()){
      popup.Items.Add("Open window",null,(_,_)=>{preview.Show();preview.Activate();});
      popup.Show(preview,new Point(80,100));Application.DoEvents();Capture("context-menu-open");popup.Close();Capture("context-menu-closed");
      preview.Hide();popup.Items[0].PerformClick();Capture("menu-open-restored");
     }
     preview.Text="CodeCang changed title";preview.Icon=SystemIcons.Warning;Capture("title-icon-updated");
   foreach(int command in new[]{0xF030,0xF120,0xF020,0xF120}){
    SendMessage(preview.Handle,0x112,(IntPtr)command,IntPtr.Zero);Application.DoEvents();Thread.Sleep(350);
    Check(preview.WindowState==(command==0xF030?FormWindowState.Maximized:command==0xF020?FormWindowState.Minimized:FormWindowState.Normal),"native state command");
    if(command==0xF030){Console.WriteLine($"Max bounds {preview.Bounds}, work {Screen.FromHandle(preview.Handle).WorkingArea}");DwmGetWindowAttribute(preview.Handle,9,out var visible,16);Console.WriteLine($"Visible frame {visible.Left},{visible.Top} {visible.Right},{visible.Bottom}; client {preview.PointToScreen(Point.Empty)} {preview.ClientSize}");Check(new Rectangle(preview.PointToScreen(Point.Empty),preview.ClientSize)==Screen.FromHandle(preview.Handle).WorkingArea,"maximized client matches work area");}if(command!=0xF020)Capture("state-"+command.ToString("X"));
   }
   preview.SetTheme(true);Capture("normal-light");preview.SetTheme(false);
   SendMessage(preview.Handle,0x86,IntPtr.Zero,IntPtr.Zero);Capture("deactivated");SendMessage(preview.Handle,0x86,(IntPtr)1,IntPtr.Zero);Capture("activated");
   SendMessage(preview.Handle,0x112,(IntPtr)0xF060,IntPtr.Zero);Application.DoEvents();Check(preview.IsDisposed,"native close command");Console.WriteLine($"Passed {checks} native assertions. Captures: {folder}");return;
  }
  if(args.Contains("--native-preview")){
   var previewOutput=Path.Combine(AppContext.BaseDirectory,"previews");Directory.CreateDirectory(previewOutput);
   var foreground=GetForegroundWindow();
   using var preview=new CaptionProbe{Text="CodeCang",Size=new Size(880,540),ShowInTaskbar=false,StartPosition=FormStartPosition.Manual,Location=new Point(-32000,-32000)};
   preview.Show();Application.DoEvents();
   foreach(var light in new[]{false,true}){
    preview.SetTheme(light);preview.Text=light?"CodeCang - Light":"CodeCang - Dark";Application.DoEvents();
    using var bitmap=new Bitmap(preview.Width,preview.Height);using(var graphics=Graphics.FromImage(bitmap)){var dc=graphics.GetHdc();try{Check(PrintWindow(preview.Handle,dc,2),"native preview print");}finally{graphics.ReleaseHdc(dc);}}bitmap.Save(Path.Combine(previewOutput,light?"light.png":"dark.png"),ImageFormat.Png);
   }
   preview.Hide();Check(GetForegroundWindow()==foreground,"preview never takes focus");Console.WriteLine(previewOutput);return;
  }
  if(args.Contains("--caption-only")){Console.WriteLine($"Passed {checks} hidden caption assertions; no visible window or model calls.");return;}
  string output=args.Length>0?args[0]:Path.Combine(Path.GetTempPath(),"codex-light-native-ui-previews");Directory.CreateDirectory(output);
  foreach(bool light in new[]{false,true}){
   foreach(int size in new[]{16,20,24,32}){
    using var icon=TrayAppearance.CreateIcon(size,light);Check(icon.Width==size&&icon.Height==size,"icon dimensions");
    using var pixels=icon.ToBitmap();Check(pixels.GetPixel(0,0).A==0,"icon background must be transparent");
    int coverage=0;for(int y=0;y<size;y++)for(int x=0;x<size;x++){Color p=pixels.GetPixel(x,y);if(p.A>0){coverage++;Check(p.R==p.G&&p.G==p.B,"icon must be neutral");}}
    Check(coverage>size*size/6&&coverage<size*size*0.65,"icon coverage");
    using var composite=new Bitmap(size*4,size*4);using(var g=Graphics.FromImage(composite)){g.Clear(light?Color.FromArgb(244,244,244):Color.FromArgb(24,24,24));g.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;g.DrawImage(pixels,0,0,composite.Width,composite.Height);}composite.Save(Path.Combine(output,$"tray-{light}-{size}.png"),ImageFormat.Png);
   }
   using var menu=new ContextMenuStrip();menu.Items.Add("打开窗口");menu.Items.Add(new ToolStripSeparator());menu.Items.Add("退出");TrayAppearance.Apply(menu,light);
   Check(!menu.ShowImageMargin&&!menu.ShowCheckMargin,"menu blank margin");Check(menu.BackColor.A==255,"menu opaque");Check(menu.BackColor.GetBrightness()>0.5==light,"menu theme");
   menu.Opacity=0;menu.Show(new Point(-32000,-32000));using(var menuBitmap=new Bitmap(menu.Width,menu.Height)){menu.DrawToBitmap(menuBitmap,new Rectangle(Point.Empty,menuBitmap.Size));menuBitmap.Save(Path.Combine(output,$"menu-{light}.png"),ImageFormat.Png);}menu.Close();
   using var dialog=new CloseChoiceDialog(light?Color.White:Color.FromArgb(24,24,24),light?Color.FromArgb(32,32,32):Color.White);
   dialog.StartPosition=FormStartPosition.Manual;dialog.Location=new Point(-32000,-32000);dialog.ShowInTaskbar=false;dialog.Opacity=0;dialog.Show();dialog.PerformLayout();Application.DoEvents();
   var buttons=Descendants(dialog).OfType<Button>().ToArray();Check(buttons.Length==3,"three actions");
   foreach(var button in buttons){Check(button.FlatAppearance.BorderColor.A==255,"opaque button border");var c=button.FlatAppearance.BorderColor;Check(c.R==c.G&&c.G==c.B,"neutral border");Check(button.Height>=36&&button.Width>=80,"usable action size");Check(!string.IsNullOrWhiteSpace(button.AccessibleName),"accessible action");}
   Check(ReferenceEquals(dialog.AcceptButton,dialog.CancelButton),"default and escape remain cancel");Check(dialog.Choice==CloseChoice.Cancel,"safe initial choice");
   using var bitmap=new Bitmap(dialog.Width,dialog.Height);dialog.DrawToBitmap(bitmap,new Rectangle(Point.Empty,bitmap.Size));bitmap.Save(Path.Combine(output,$"dialog-{light}.png"),ImageFormat.Png);dialog.Close();
  }
  Console.WriteLine($"Passed {checks} native appearance assertions; transparent offscreen rendering only. Previews: {output}");
 }
 static void CheckCaptionCommands(){
  // Never show or activate this HWND. Consume commands before Windows changes state.
  IntPtr foreground=GetForegroundWindow();
  using var window=new CaptionProbe();var handle=window.Handle;
  Check(GetWindowRect(handle,out var outer)&&GetClientRect(handle,out var client)&&outer.Height==client.Height,"native overlay gives full client area");
  Check((window.NativeStyle&0x00C00000)==0x00C00000,"native caption semantics retained");
  Check((window.NativeStyle&0x000F0000)==0x000F0000,"resize/system/min/max styles retained");
  Check(!window.Visible,"probe remains hidden");
  Check(!Descendants(window).OfType<Button>().Any(),"no duplicate client caption buttons");
  foreach(var title in new[]{"CodeCang","CodeCang - New conversation",""}){
   window.Text=title;Application.DoEvents();Check(window.Text==title,"native title update retained");
   Check(GetWindowRect(handle,out outer)&&GetClientRect(handle,out client)&&outer.Height==client.Height,"title update retains overlay area");
   Check(!window.Visible&&GetForegroundWindow()==foreground,"title update cannot show or activate probe");
  }
  window.Icon=SystemIcons.Application;Application.DoEvents();Check(!window.Visible,"icon update stays hidden");
  Check(GetForegroundWindow()==foreground,"probe never steals foreground");

 }
 sealed class CaptionProbe:CaptionWindow {
  protected override bool ShowWithoutActivation=>true;
  public void SetTheme(bool light)=>SetCaptionTheme(light);
  public bool AllowCommands;public readonly List<int> Commands=new();public int NativeStyle=>CreateParams.Style;
  protected override void WndProc(ref Message message){
   if(message.Msg==0x0112&&!AllowCommands){Commands.Add((int)message.WParam&0xFFF0);message.Result=IntPtr.Zero;return;}
   base.WndProc(ref message);
  }
 }

 [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]struct NativeRect {public int Left,Top,Right,Bottom;public int Width=>Right-Left;public int Height=>Bottom-Top;}
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out NativeRect rect);
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool GetClientRect(IntPtr window,out NativeRect rect);
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern IntPtr SendMessage(IntPtr hwnd,int msg,IntPtr wp,IntPtr lp);
 [System.Runtime.InteropServices.DllImport("dwmapi.dll")]static extern int DwmGetWindowAttribute(IntPtr hwnd,int attr,out NativeRect value,int size);
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool PrintWindow(IntPtr hwnd,IntPtr hdc,uint flags);

}
