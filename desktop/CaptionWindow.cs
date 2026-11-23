using System.Runtime.InteropServices;
namespace CodexLight.Desktop;

// Use the native caption during startup, then an opaque WebView caption when
// ready. Windows retains resizing, system commands and restore geometry.
internal class CaptionWindow : Form {
 protected readonly MenuStrip CaptionMenu=new(){Dock=DockStyle.Top,Visible=false,TabStop=true,AccessibleName="应用菜单"};
 protected event EventHandler? CaptionBrandInvoked;
 bool lightTheme;string visualStyle="codex";bool trackingBrandPress,brandDragObserved,brandPressCanceled;
 bool webCaption;
 protected void EnableWebCaption(){
  webCaption=true;
  // Recalculate the frame without activating a window the user left in the background.
  if(IsHandleCreated)SetWindowPos(Handle,IntPtr.Zero,0,0,0,0,0x0037);
 }
 bool InCaptionBrand(Point screen){
  if(!IsHandleCreated||!ControlBox)return false;
  // Measure against the actual HWND DPI. The OS still renders every pixel.
  using var graphics=CreateGraphics();
  var font=SystemFonts.CaptionFont??Font;
  int text=TextRenderer.MeasureText(graphics,Text,font,Size.Empty,TextFormatFlags.NoPadding|TextFormatFlags.SingleLine).Width;
  int scale(int px)=>(int)Math.Round(px*DeviceDpi/96d);
  int left=Bounds.Left,width=Math.Min(text+scale(48),Math.Max(0,Width-scale(150)));
  return screen.X>=left+scale(5)&&screen.X<left+width;
 }
 internal static bool WasCaptionClick(Point before,Point after,Rectangle startBounds,Rectangle endBounds,Size drag)=>
  startBounds==endBounds&&Math.Abs(after.X-before.X)<Math.Max(1,drag.Width/2)&&Math.Abs(after.Y-before.Y)<Math.Max(1,drag.Height/2);
 [DllImport("user32.dll")]static extern IntPtr LoadCursor(IntPtr instance,IntPtr name);
 [DllImport("user32.dll")]static extern IntPtr SetCursor(IntPtr cursor);
 protected static bool IsCaptionStyle(string? style)=>style is "codex" or "claude" or "dsh";
 Color CaptionSurface=>SystemInformation.HighContrast?SystemColors.Window:visualStyle switch {
  "claude"=>lightTheme?Color.FromArgb(250,249,245):Color.FromArgb(38,38,36),
  "dsh"=>lightTheme?Color.White:Color.FromArgb(21,21,23),
  _=>lightTheme?Color.FromArgb(252,252,253):Color.FromArgb(26,29,34),
 };
 protected bool HasIntegratedCaption=>true;
 protected void RefreshCaptionLayout(){
  // F10/Alt menus are temporary client content, never placed on the glass.
  CaptionMenu.Dock=DockStyle.Top;
 }
 public CaptionWindow(){
  Font=new Font("Microsoft YaHei UI",9f,FontStyle.Regular,GraphicsUnit.Point);
  FormBorderStyle=FormBorderStyle.Sizable;MinimizeBox=true;MaximizeBox=true;ControlBox=true;
  AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;
  MainMenuStrip=CaptionMenu;Controls.Add(CaptionMenu);
  CaptionMenu.MenuDeactivate+=(_,_)=>CaptionMenu.Visible=false;
  SetCaptionTheme(false);
 }
 protected void SetCaptionTheme(bool light,string style="codex"){
  if(!IsCaptionStyle(style))throw new ArgumentException("Invalid caption style",nameof(style));
  lightTheme=light;visualStyle=style;BackColor=CaptionSurface;
  ForeColor=SystemInformation.HighContrast?SystemColors.WindowText:style switch {
   "codex"=>light?Color.FromArgb(35,41,49):Color.FromArgb(228,232,238),
   "dsh"=>light?Color.FromArgb(15,17,21):Color.FromArgb(249,250,251),
   _=>light?Color.FromArgb(32,32,32):Color.White,
  };
  CaptionMenu.BackColor=BackColor;CaptionMenu.ForeColor=ForeColor;
  CaptionMenu.Renderer=SystemInformation.HighContrast?new ToolStripSystemRenderer():new ToolStripProfessionalRenderer(new CaptionColors(light,BackColor));
  void UpdateItems(ToolStripItemCollection items){foreach(ToolStripItem item in items){item.ForeColor=ForeColor;if(item is ToolStripMenuItem menu){menu.DropDown.BackColor=SystemInformation.HighContrast?SystemColors.Window:light?Color.White:Color.FromArgb(36,36,36);menu.DropDown.ForeColor=ForeColor;UpdateItems(menu.DropDownItems);}}}
  UpdateItems(CaptionMenu.Items);if(IsHandleCreated)ApplyNativeCaption();Invalidate(true);
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
  if(trackingBrandPress){if(m.Msg==0x0216)brandDragObserved=true;if(m.Msg==0x0100&&m.WParam.ToInt64()==27)brandPressCanceled=true;}
  // Do not paint an overlay or turn the whole title into a button. Let Windows
  // run its normal caption move loop, then distinguish a click from a drag.
  if(m.Msg==0x00A1&&(m.WParam.ToInt64() is 2 or 3)&&InCaptionBrand(Cursor.Position)){
   var point=Cursor.Position;var bounds=Bounds;var state=WindowState;
   m.WParam=(IntPtr)2; // icon+label share caption drag semantics, not system-menu click
   trackingBrandPress=true;brandDragObserved=false;brandPressCanceled=false;
   try{base.WndProc(ref m);}finally{trackingBrandPress=false;}
   if(!brandDragObserved&&!brandPressCanceled&&!IsDisposed&&WindowState==state&&WasCaptionClick(point,Cursor.Position,bounds,Bounds,SystemInformation.DragSize))CaptionBrandInvoked?.Invoke(this,EventArgs.Empty);
   return;
  }
  if(m.Msg==0x00A3&&(m.WParam.ToInt64() is 2 or 3)&&InCaptionBrand(Cursor.Position))m.WParam=(IntPtr)2;
  if(m.Msg==0x0020&&((m.LParam.ToInt64()&0xffff) is 2 or 3)&&InCaptionBrand(Cursor.Position)){
   SetCursor(LoadCursor(IntPtr.Zero,(IntPtr)32649));m.Result=(IntPtr)1;return;
  }

  // Do not intercept NCCALCSIZE/NCHITTEST/GETMINMAXINFO. DefWindowProc maintains
  // correct client geometry through minimize, maximize, DPI changes and restore.
  base.WndProc(ref m);
  if(IsHandleCreated&&(m.Msg is 0x031A or 0x0320 or 0x001A or 0x031E))ApplyNativeCaption();
 }
 sealed class CaptionColors:ProfessionalColorTable {
  readonly Color Surface,Popup,Selected,Border;
  public CaptionColors(bool light=false,Color? surface=null){Surface=surface??(light?Color.White:Color.FromArgb(24,24,24));Popup=light?Color.White:Color.FromArgb(36,36,36);Selected=light?Color.FromArgb(230,230,230):Color.FromArgb(50,50,50);Border=light?Color.FromArgb(210,210,210):Color.FromArgb(64,64,64);}
  public override Color MenuStripGradientBegin=>Surface;public override Color MenuStripGradientEnd=>Surface;
  public override Color ToolStripDropDownBackground=>Popup;public override Color ImageMarginGradientBegin=>Popup;public override Color ImageMarginGradientMiddle=>Popup;public override Color ImageMarginGradientEnd=>Popup;
  public override Color MenuItemSelected=>Selected;public override Color MenuItemSelectedGradientBegin=>Selected;public override Color MenuItemSelectedGradientEnd=>Selected;
  public override Color MenuItemBorder=>Border;public override Color MenuBorder=>Border;public override Color SeparatorDark=>Border;public override Color SeparatorLight=>Popup;
  public override Color MenuItemPressedGradientBegin=>Popup;public override Color MenuItemPressedGradientMiddle=>Popup;public override Color MenuItemPressedGradientEnd=>Popup;
 }
 [DllImport("dwmapi.dll")]static extern int DwmSetWindowAttribute(IntPtr hwnd,int attribute,ref int value,int size);
 [StructLayout(LayoutKind.Sequential)]struct CaptionRect{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")]static extern bool IsZoomed(IntPtr hwnd);
 [DllImport("user32.dll")]static extern int GetSystemMetricsForDpi(int index,uint dpi);
 [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int width,int height,uint flags);
}
