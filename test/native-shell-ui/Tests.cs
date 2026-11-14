using CodexLight.Desktop;
using System.Drawing.Imaging;
internal static class Tests {
 static int checks;
 static void Check(bool result,string message){checks++;if(!result)throw new Exception(message);}
 static IEnumerable<Control> Descendants(Control control){foreach(Control child in control.Controls){yield return child;foreach(var item in Descendants(child))yield return item;}}
 [STAThread]static void Main(string[] args){
  Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);Application.EnableVisualStyles();
  CheckCaptionCommands();
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
  Check(GetWindowRect(handle,out var outer)&&GetClientRect(handle,out var client)&&outer.Width==client.Width&&outer.Height==client.Height,"caption stays integrated with no native title strip");
  Check((window.NativeStyle&0x00C00000)==0x00C00000,"native caption semantics retained");
  Check((window.NativeStyle&0x000F0000)==0x000F0000,"resize/system/min/max styles retained");
  Check(!window.Visible,"probe must remain hidden");
  foreach(var pair in new[]{("minimize",0xF020),("maximize",0xF030)}){
   var field=typeof(CaptionWindow).GetField(pair.Item1,System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance)!;
   var button=(Button)field.GetValue(window)!;
   Check(button.TabStop&&!string.IsNullOrEmpty(button.AccessibleName),"caption keyboard/accessibility preserved");
   typeof(Control).GetMethod("OnClick",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance)!.Invoke(button,new object[]{EventArgs.Empty});
   Check(window.Commands.Count==0,"command is asynchronously queued");Application.DoEvents();
   Check(window.Commands.SequenceEqual(new[]{pair.Item2}),"caption uses native system command");window.Commands.Clear();
   Check(!window.Visible,"command probe never shown");
   Check(GetForegroundWindow()==foreground,"probe must not steal foreground");
  }
 }
 sealed class CaptionProbe:CaptionWindow {
  public readonly List<int> Commands=new();public int NativeStyle=>CreateParams.Style;
  protected override void WndProc(ref Message message){
   if(message.Msg==0x0112){Commands.Add((int)message.WParam&0xFFF0);message.Result=IntPtr.Zero;return;}
   base.WndProc(ref message);
  }
 }

 [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]struct NativeRect {public int Left,Top,Right,Bottom;public int Width=>Right-Left;public int Height=>Bottom-Top;}
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out NativeRect rect);
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool GetClientRect(IntPtr window,out NativeRect rect);
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();

}
