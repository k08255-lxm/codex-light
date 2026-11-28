using System.Runtime.InteropServices;
namespace CodexLight.Desktop;

// Use the native caption during startup, then an opaque WebView caption when
// ready. Windows retains resizing, system commands and restore geometry.
internal class CaptionWindow : Form {
 bool lightTheme;string visualStyle="codex";
 bool webCaption;
 protected void EnableWebCaption(){
  webCaption=true;
  // Recalculate the frame without activating a window the user left in the background.
  if(IsHandleCreated)SetWindowPos(Handle,IntPtr.Zero,0,0,0,0,0x0037);
 }
 protected static bool IsCaptionStyle(string? style)=>style is "codex" or "claude" or "dsh";
 Color CaptionSurface=>SystemInformation.HighContrast?SystemColors.Window:visualStyle switch {
  "claude"=>lightTheme?Color.FromArgb(250,249,245):Color.FromArgb(38,38,36),
  "dsh"=>lightTheme?Color.White:Color.FromArgb(21,21,23),
  _=>lightTheme?Color.FromArgb(252,252,253):Color.FromArgb(24,25,26),
 };
 protected bool HasIntegratedCaption=>true;
 public CaptionWindow(){
  Font=new Font("Microsoft YaHei UI",9f,FontStyle.Regular,GraphicsUnit.Point);
  FormBorderStyle=FormBorderStyle.Sizable;MinimizeBox=true;MaximizeBox=true;ControlBox=true;
  AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;
  SetCaptionTheme(false);
 }
 protected void SetCaptionTheme(bool light,string style="codex"){
  if(!IsCaptionStyle(style))throw new ArgumentException("Invalid caption style",nameof(style));
  lightTheme=light;visualStyle=style;BackColor=CaptionSurface;
  ForeColor=SystemInformation.HighContrast?SystemColors.WindowText:style switch {
   "codex"=>light?Color.FromArgb(35,41,49):Color.FromArgb(207,208,209),
   "dsh"=>light?Color.FromArgb(15,17,21):Color.FromArgb(249,250,251),
   _=>light?Color.FromArgb(32,32,32):Color.White,
  };
  if(IsHandleCreated)ApplyNativeCaption();Invalidate(true);
 }
 void SetDwm(int attribute,int value){int result=DwmSetWindowAttribute(Handle,attribute,ref value,sizeof(int));if(result<0)System.Diagnostics.Trace.WriteLine($"DWM caption attribute {attribute} unavailable: 0x{result:X8}");}
 void ApplyNativeCaption(){
  SetDwm(20,lightTheme?0:1);
  if(OperatingSystem.IsWindowsVersionAtLeast(10,0,22000)){
   SetDwm(33,2);
   SetDwm(34,SystemInformation.HighContrast?-1:ColorTranslator.ToWin32(CaptionSurface));
   SetDwm(35,SystemInformation.HighContrast?-1:ColorTranslator.ToWin32(CaptionSurface));
   SetDwm(36,SystemInformation.HighContrast?-1:ColorTranslator.ToWin32(ForeColor));
  }
 }
 protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);ApplyNativeCaption();}
 protected override void WndProc(ref Message m){
  if(webCaption&&m.Msg==0x0083&&m.WParam!=IntPtr.Zero){
   // Keep DefWindowProc's side/bottom resize borders and maximized bounds. Only
   // replace the caption height with an opaque WebView title bar; no glass/GDI overlay.
   var original=Marshal.PtrToStructure<CaptionRect>(m.LParam);
   base.WndProc(ref m);
   var client=Marshal.PtrToStructure<CaptionRect>(m.LParam);
   int border=GetSystemMetricsForDpi(33,(uint)DeviceDpi)+GetSystemMetricsForDpi(92,(uint)DeviceDpi);
   client.Top=original.Top+(IsZoomed(Handle)?border:1);
   Marshal.StructureToPtr(client,m.LParam,false);m.Result=IntPtr.Zero;return;
  }
  if(webCaption){
   base.WndProc(ref m);
   if(m.Msg==0x0084&&m.Result==(IntPtr)1&&!IsZoomed(Handle)){
    // WM_NCHITTEST supplies the screen point being queried, including negative
    // coordinates on monitors to the left or above the primary display.
    long packed=m.LParam.ToInt64();
    var point=PointToClient(new Point(unchecked((short)packed),unchecked((short)(packed>>16))));
    int edge=Math.Max(4,(int)Math.Round(6*DeviceDpi/96d));
    if(point.Y<edge)m.Result=(IntPtr)(point.X<edge?13:point.X>=ClientSize.Width-edge?14:12);
   }
   if(IsHandleCreated&&(m.Msg is 0x031A or 0x0320 or 0x001A or 0x031E))ApplyNativeCaption();
   return;
  }
  // Do not intercept NCCALCSIZE/NCHITTEST/GETMINMAXINFO. DefWindowProc maintains
  // correct client geometry through minimize, maximize, DPI changes and restore.
  base.WndProc(ref m);
  if(IsHandleCreated&&(m.Msg is 0x031A or 0x0320 or 0x001A or 0x031E))ApplyNativeCaption();
 }
 [DllImport("dwmapi.dll")]static extern int DwmSetWindowAttribute(IntPtr hwnd,int attribute,ref int value,int size);
 [StructLayout(LayoutKind.Sequential)]struct CaptionRect{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")]static extern bool IsZoomed(IntPtr hwnd);
 [DllImport("user32.dll")]static extern int GetSystemMetricsForDpi(int index,uint dpi);
 [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int width,int height,uint flags);
}
