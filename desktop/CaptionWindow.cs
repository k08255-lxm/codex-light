using System.Runtime.InteropServices;
namespace CodexLight.Desktop;

// Keep the whole caption in the non-client area. Ordinary GDI controls cannot
// safely draw into DWM's extended glass: their glyph alpha becomes transparent.
// DWM owns the title, icon, caption buttons, hit testing and restore animations.
internal class CaptionWindow : Form {
 protected readonly MenuStrip CaptionMenu=new(){Dock=DockStyle.Top,Visible=false,TabStop=true,AccessibleName="应用菜单"};
 protected event EventHandler? CaptionBrandInvoked;
 bool lightTheme;string visualStyle="codex";bool trackingBrandPress,brandDragObserved,brandPressCanceled;
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
 Color CaptionSurface=>SystemInformation.HighContrast?SystemColors.Window:visualStyle=="claude"?(lightTheme?Color.FromArgb(250,249,245):Color.FromArgb(38,38,36)):(lightTheme?Color.White:Color.FromArgb(24,24,24));
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
  if(style!="codex"&&style!="claude")throw new ArgumentException("Invalid caption style",nameof(style));
  lightTheme=light;visualStyle=style;BackColor=CaptionSurface;
  ForeColor=SystemInformation.HighContrast?SystemColors.WindowText:light?Color.FromArgb(32,32,32):Color.White;
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
}
