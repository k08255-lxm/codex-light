using CodexLight.Desktop;
using System.Drawing.Imaging;
internal static class Tests {
 static int checks;
 static void Check(bool result,string message){checks++;if(!result)throw new Exception(message);}
 static IEnumerable<Control> Descendants(Control control){foreach(Control child in control.Controls){yield return child;foreach(var item in Descendants(child))yield return item;}}
 [STAThread]static void Main(string[] args){
  try{
   if(args.Contains("--web-caption-worker")){
    if(args.Length!=2||args[0]!="--web-caption-worker")throw new ArgumentException("Invalid isolated worker arguments");
    isolatedDesktopName=args[1];CheckIsolatedDesktop();Run(new[]{"--web-caption-layout"});
   }else if(args.Contains("--web-caption-layout"))RunOnIsolatedDesktop();else Run(args);
  }catch(Exception error){Console.Error.WriteLine(error);Environment.ExitCode=1;}
 }
 static string? isolatedDesktopName;
 static void RunOnIsolatedDesktop(){
  // Select the desktop at process creation, before .NET/WinForms creates STA
  // windows. Never request SWITCHDESKTOP access or fall back to the input desktop.
  string name="CodeCangUiTest-"+Guid.NewGuid().ToString("N");
  var desktop=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x00C7,IntPtr.Zero); // Read/write objects, create windows/menus, enumerate.
  if(desktop==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(),"Cannot create isolated test desktop");
  string log=Path.Combine(AppContext.BaseDirectory,name+".log");
  try{
   string executable=Environment.ProcessPath??throw new InvalidOperationException("Cannot locate test executable");
   string command="\""+executable+"\"";
   if(string.Equals(Path.GetFileNameWithoutExtension(executable),"dotnet",StringComparison.OrdinalIgnoreCase))command+=" \""+typeof(Tests).Assembly.Location+"\"";
   command+=" --web-caption-worker "+name;
   using var capture=new FileStream(log,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.ReadWrite);
   var output=capture.SafeFileHandle.DangerousGetHandle();
   if(!SetHandleInformation(output,1,1))throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
   var startup=new StartupInfo{Size=System.Runtime.InteropServices.Marshal.SizeOf<StartupInfo>(),Desktop=name,Flags=0x180,Input=output,Output=output,Error=output}; // Std handles + no startup cursor feedback.
   if(!CreateProcess(executable,new System.Text.StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000000,IntPtr.Zero,null,ref startup,out var process))throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(),"Cannot launch isolated test worker");
   try{
    if(WaitForSingleObject(process.Process,45000)!=0){TerminateProcess(process.Process,1);WaitForSingleObject(process.Process,5000);throw new TimeoutException("Isolated test worker did not exit; no input-desktop fallback was attempted");}
    capture.Dispose();Console.Write(File.ReadAllText(log));
    if(!GetExitCodeProcess(process.Process,out var exitCode))throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
    Check(exitCode==0,"isolated desktop worker failed; no input-desktop fallback was attempted (exit "+exitCode+")");
   }finally{CloseHandle(process.Thread);CloseHandle(process.Process);}
  }finally{
   if(File.Exists(log))File.Delete(log);
   if(!CloseDesktop(desktop))throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(),"Cannot close isolated test desktop");
  }
 }
 static string DesktopName(IntPtr desktop){
  var name=new System.Text.StringBuilder(256);
  if(!GetUserObjectInformation(desktop,2,name,(uint)(name.Capacity*2),out _))throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
  return name.ToString();
 }
 static void CheckIsolatedDesktop(){
  const string prefix="CodeCangUiTest-";
  if(isolatedDesktopName==null||!isolatedDesktopName.StartsWith(prefix,StringComparison.Ordinal)||!Guid.TryParseExact(isolatedDesktopName[prefix.Length..],"N",out _))throw new InvalidOperationException("Geometry checks require an isolated desktop");
  var input=OpenInputDesktop(0,false,0x0001);
  if(input==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(),"Cannot verify the input desktop; refusing geometry checks");
  try{
   Check(string.Equals(DesktopName(GetThreadDesktop(GetCurrentThreadId())),isolatedDesktopName,StringComparison.OrdinalIgnoreCase),"fixture thread is attached to its dedicated desktop");
   Check(!string.Equals(DesktopName(input),isolatedDesktopName,StringComparison.OrdinalIgnoreCase),"fixture desktop is not the user's input desktop");
  }finally{CloseDesktop(input);}
 }
 static void Run(string[] args){
  Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);Application.EnableVisualStyles();
  if(args.Contains("--dialog-only")){
   string destination=args.FirstOrDefault(value=>value!="--dialog-only")??Path.Combine(Path.GetTempPath(),"codecang-close-font-previews");Directory.CreateDirectory(destination);
   foreach(bool light in new[]{false,true})foreach(float scale in new[]{1f,1.5f,2f}){
    using var dialog=new CloseChoiceDialog(light?Color.White:Color.FromArgb(24,24,24),light?Color.FromArgb(32,32,32):Color.White);
    bool activated=false,focused=false;dialog.Activated+=(_,_)=>activated=true;dialog.GotFocus+=(_,_)=>focused=true;
    dialog.StartPosition=FormStartPosition.Manual;dialog.Location=new Point(-32000,-32000);dialog.ShowInTaskbar=false;dialog.Opacity=0;
    // Shown intentionally focuses Cancel in production; never raise Shown for a layout-only fixture.
    _=dialog.Handle;dialog.PerformLayout();Application.DoEvents();
    if(scale!=1f)dialog.Scale(new SizeF(scale,scale));
    dialog.PerformLayout();
    var buttons=Descendants(dialog).OfType<Button>().ToArray();Check(buttons.Length==3,"three close actions");
    foreach(var control in Descendants(dialog).Where(value=>value is Button or Label or CheckBox)){
     var position=control.Location;for(Control? parent=control.Parent;parent!=null&&parent!=dialog;parent=parent.Parent)position.Offset(parent.Location);
     var bounds=new Rectangle(position,control.Size);
     Check(dialog.ClientRectangle.Contains(bounds),$"dialog text stays inside at scale {scale}: {bounds} within {dialog.ClientRectangle}: "+control.Text);
    }
    Check(ReferenceEquals(dialog.AcceptButton,dialog.CancelButton),"Enter and Escape cancel");
    Check(dialog.Opacity==0&&!dialog.ShowInTaskbar&&!Screen.AllScreens.Any(screen=>screen.Bounds.IntersectsWith(dialog.Bounds)),"font preview remains transparent and outside every display");
    using var bitmap=new Bitmap(dialog.Width,dialog.Height);dialog.DrawToBitmap(bitmap,new Rectangle(Point.Empty,bitmap.Size));bitmap.Save(Path.Combine(destination,$"dialog-{light}-{scale:0.0}.png"),ImageFormat.Png);
    Check(!dialog.Visible&&!IsWindowVisible(dialog.Handle),"font preview never shows its HWND");
    Check(!activated&&!focused&&GetForegroundWindow()!=dialog.Handle,"font preview never activates or receives focus");
   }
   Console.WriteLine($"Passed {checks} hidden close-dialog layout assertions at 100/150/200 percent; previews: {destination}");return;
  }
  CheckCaptionCommands();
  if(args.Contains("--web-caption-layout")){
   CheckIsolatedDesktop();
   using var probe=new CaptionProbe{Text="Caption layout fixture",AllowCommands=true,Size=new Size(880,540),StartPosition=FormStartPosition.Manual,Location=new Point(-32000,-32000),ShowInTaskbar=false,Opacity=0,Enabled=false};
   probe.UseWebCaption();probe.Show();Application.DoEvents();var original=probe.Bounds;
   foreach(var state in new[]{FormWindowState.Maximized,FormWindowState.Normal,FormWindowState.Minimized,FormWindowState.Normal}){
    CheckIsolatedDesktop();
    probe.WindowState=state;Application.DoEvents();
    Check(probe.WindowState==state,"web caption preserves native window state "+state);
    if(state==FormWindowState.Maximized)Check(new Rectangle(probe.PointToScreen(Point.Empty),probe.ClientSize)==Screen.FromHandle(probe.Handle).WorkingArea,"maximized web client matches work area");
    if(state==FormWindowState.Normal)Check(probe.Bounds==original,"web caption restore preserves bounds");
    Check(probe.Opacity==0&&!probe.Enabled&&!probe.ShowInTaskbar,"layout fixture stays transparent and noninteractive");
    CheckIsolatedDesktop();
   }
   probe.Hide();CheckIsolatedDesktop();Console.WriteLine($"Passed {checks} isolated web caption layout assertions; input desktop was never switched, no model calls.");return;
  }
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
   foreach(var button in buttons){Check(button.FlatAppearance.BorderColor.A==255,"opaque button border");var c=button.FlatAppearance.BorderColor;Check(c.R==c.G&&c.G==c.B,"neutral border");Check(button.Height>=32&&button.Width>=80,"usable action size");Check(!string.IsNullOrWhiteSpace(button.AccessibleName),"accessible action");}
   Check(ReferenceEquals(dialog.AcceptButton,dialog.CancelButton),"default and escape remain cancel");Check(dialog.Choice==CloseChoice.Cancel,"safe initial choice");
   using var bitmap=new Bitmap(dialog.Width,dialog.Height);dialog.DrawToBitmap(bitmap,new Rectangle(Point.Empty,bitmap.Size));bitmap.Save(Path.Combine(output,$"dialog-{light}.png"),ImageFormat.Png);dialog.Close();
  }
  Console.WriteLine($"Passed {checks} native appearance assertions; transparent offscreen rendering only. Previews: {output}");
 }
 static void CheckCaptionCommands(){
  // Never show or activate this HWND. Consume commands before Windows changes state.
  using var window=new CaptionProbe();var handle=window.Handle;
  GetClientRect(handle,out var client);
  Check(GetWindowRect(handle,out var outer)&&outer.Height>client.Height,"startup retains native frame until WebView is ready");
  var originalHeight=client.Height;window.UseWebCaption();
  Check(GetClientRect(handle,out client)&&client.Height>originalHeight,"web caption reclaims the native title area");
  var webHeight=client.Height;
  Check((window.NativeStyle&0x00C00000)==0x00C00000,"native caption semantics retained");
  Check((window.NativeStyle&0x000F0000)==0x000F0000,"resize/system/min/max styles retained");
  Check(!window.Visible,"probe remains hidden");
  Check(!Descendants(window).OfType<Button>().Any(),"no duplicate client caption buttons");
  foreach(var title in new[]{"CodeCang","CodeCang - New conversation",""}){
   window.Text=title;Application.DoEvents();Check(window.Text==title,"native title update retained");
   Check(GetWindowRect(handle,out outer)&&GetClientRect(handle,out client)&&client.Height==webHeight,"title update retains web caption area");
   CheckHiddenProbe(window,"title update");
  }
  window.Icon=SystemIcons.Application;Application.DoEvents();Check(!window.Visible,"icon update stays hidden");
  CheckHiddenProbe(window,"icon update");

 }
 static void CheckHiddenProbe(CaptionProbe window,string operation){
  // The user may switch other apps while a hidden test runs. Track this HWND's
  // transitions instead of requiring the entire desktop's foreground to freeze.
  Check(!window.Visible&&!IsWindowVisible(window.Handle)&&!window.SawVisible,operation+" never shows probe");
  Check(!window.SawActivation&&!window.SawFocus,operation+" never activates or focuses probe");
  Check(GetForegroundWindow()!=window.Handle,operation+" leaves foreground outside probe");
 }
 sealed class CaptionProbe:CaptionWindow {
  protected override bool ShowWithoutActivation=>true;
  public void SetTheme(bool light)=>SetCaptionTheme(light);
  public void UseWebCaption()=>EnableWebCaption();
  public bool AllowCommands;public readonly List<int> Commands=new();public int NativeStyle=>CreateParams.Style;
  public bool SawActivation,SawFocus,SawVisible;
  protected override void OnVisibleChanged(EventArgs e){if(Visible)SawVisible=true;base.OnVisibleChanged(e);}
  protected override void WndProc(ref Message message){
   if(message.Msg==0x0006&&(message.WParam.ToInt64()&0xffff)!=0)SawActivation=true;
   if(message.Msg==0x0007)SawFocus=true;
   if(message.Msg==0x0112&&!AllowCommands){Commands.Add((int)message.WParam&0xFFF0);message.Result=IntPtr.Zero;return;}
   base.WndProc(ref message);
  }
 }

 [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]struct NativeRect {public int Left,Top,Right,Bottom;public int Width=>Right-Left;public int Height=>Bottom-Top;}
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out NativeRect rect);
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool GetClientRect(IntPtr window,out NativeRect rect);
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr window);
 [System.Runtime.InteropServices.DllImport("user32.dll",EntryPoint="CreateDesktopW",CharSet=System.Runtime.InteropServices.CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,uint flags,uint access,IntPtr attributes);
 [System.Runtime.InteropServices.DllImport("user32.dll",SetLastError=true)]static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [System.Runtime.InteropServices.DllImport("user32.dll",SetLastError=true)]static extern bool CloseDesktop(IntPtr desktop);
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern IntPtr GetThreadDesktop(uint thread);
 [System.Runtime.InteropServices.DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
 [System.Runtime.InteropServices.DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",CharSet=System.Runtime.InteropServices.CharSet.Unicode,SetLastError=true)]static extern bool GetUserObjectInformation(IntPtr handle,int index,System.Text.StringBuilder value,uint size,out uint required);
 [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential,CharSet=System.Runtime.InteropServices.CharSet.Unicode)]struct StartupInfo {public int Size;public string? Reserved,Desktop,Title;public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;public ushort Show,ReservedSize;public IntPtr ReservedBytes,Input,Output,Error;}
 [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]struct ProcessInfo {public IntPtr Process,Thread;public uint ProcessId,ThreadId;}
 [System.Runtime.InteropServices.DllImport("kernel32.dll",EntryPoint="CreateProcessW",CharSet=System.Runtime.InteropServices.CharSet.Unicode,SetLastError=true)]static extern bool CreateProcess(string executable,System.Text.StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string? directory,ref StartupInfo startup,out ProcessInfo process);
 [System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)]static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)]static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr process,uint code);
 [System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)]static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [System.Runtime.InteropServices.DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern IntPtr SendMessage(IntPtr hwnd,int msg,IntPtr wp,IntPtr lp);
 [System.Runtime.InteropServices.DllImport("dwmapi.dll")]static extern int DwmGetWindowAttribute(IntPtr hwnd,int attr,out NativeRect value,int size);
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool PrintWindow(IntPtr hwnd,IntPtr hdc,uint flags);

}
