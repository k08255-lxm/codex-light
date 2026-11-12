using System.Runtime.InteropServices;
namespace CodexLight.Desktop;
// Stable client caption: real accessible buttons; native sizing/system styles remain.
// Native maximize hover Snap is deliberately not claimed for these client buttons.
internal class CaptionWindow : Form {
 protected readonly MenuStrip CaptionMenu=new CaptionMenuStrip(){Dock=DockStyle.None,AutoSize=false,TabStop=true,AccessibleName="应用菜单",BackColor=Color.FromArgb(24,24,24),ForeColor=Color.White};
 readonly CaptionButton minimize=new(CaptionAction.Minimize),maximize=new(CaptionAction.Maximize),close=new(CaptionAction.Close);
 bool lightTheme;string visualStyle="codex";
 Color CaptionSurface=>SystemInformation.HighContrast?SystemColors.Window:visualStyle=="claude"?(lightTheme?Color.FromArgb(250,249,245):Color.FromArgb(38,38,36)):(lightTheme?Color.White:Color.FromArgb(24,24,24));
 protected void SetCaptionTheme(bool light,string style="codex"){
  if(style!="codex"&&style!="claude")throw new ArgumentException("Invalid caption style",nameof(style));
  lightTheme=light;visualStyle=style;BackColor=CaptionSurface;ForeColor=SystemInformation.HighContrast?SystemColors.WindowText:light?Color.FromArgb(32,32,32):Color.White;
  CaptionMenu.BackColor=CaptionSurface;CaptionMenu.ForeColor=ForeColor;
  CaptionMenu.Renderer=SystemInformation.HighContrast?new ToolStripSystemRenderer():new ToolStripProfessionalRenderer(new CaptionColors(light,CaptionSurface));
  void UpdateItems(ToolStripItemCollection items){foreach(ToolStripItem item in items){item.ForeColor=ForeColor;if(item is ToolStripMenuItem menu){menu.DropDown.BackColor=SystemInformation.HighContrast?SystemColors.Window:light?Color.White:Color.FromArgb(36,36,36);menu.DropDown.ForeColor=ForeColor;UpdateItems(menu.DropDownItems);}}}
  UpdateItems(CaptionMenu.Items);
  foreach(var button in new[]{minimize,maximize,close}){button.Light=light;button.BackColor=CaptionSurface;button.ForeColor=ForeColor;button.Invalidate();}
  if(IsHandleCreated)ApplyDwmFrameAppearance();
  Invalidate();
 }
 protected bool HasIntegratedCaption=>true;
 protected void RefreshCaptionLayout()=>LayoutCaption();
 int Scale(int value)=>Math.Max(1,(int)Math.Round(value*DeviceDpi/96d));
 int CaptionHeight=>Scale(40);
 int ResizeWidth=>Math.Max(1,GetSystemMetricsForDpi(32,(uint)DeviceDpi)+GetSystemMetricsForDpi(92,(uint)DeviceDpi));
 int ResizeHeight=>Math.Max(1,GetSystemMetricsForDpi(33,(uint)DeviceDpi)+GetSystemMetricsForDpi(92,(uint)DeviceDpi));
 public CaptionWindow(){
  Font=new Font("Microsoft YaHei UI",9f,FontStyle.Regular,GraphicsUnit.Point);
  FormBorderStyle=FormBorderStyle.Sizable;MinimizeBox=true;MaximizeBox=true;ControlBox=true;AutoScaleMode=AutoScaleMode.Dpi;
  SetStyle(ControlStyles.ResizeRedraw|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);
  MainMenuStrip=CaptionMenu;Controls.Add(CaptionMenu);CaptionMenu.Renderer=new ToolStripProfessionalRenderer(new CaptionColors());
  minimize.AccessibleName="最小化";maximize.AccessibleName="最大化";close.AccessibleName="关闭";
  minimize.TabIndex=100;maximize.TabIndex=101;close.TabIndex=102;
  Controls.AddRange(new Control[]{minimize,maximize,close});
  minimize.Click+=(_,_)=>WindowState=FormWindowState.Minimized;
  maximize.Click+=(_,_)=>ToggleMaximize();close.Click+=(_,_)=>Close();
 }
 protected override CreateParams CreateParams {get{var cp=base.CreateParams;cp.Style&=~0x00C00000;cp.Style|=0x00040000|0x00080000|0x00020000|0x00010000;cp.ClassStyle|=0x0001|0x0002;return cp;}}
 // WS_THICKFRAME is intentionally retained for native resize/system-menu behavior.
 // Its one-pixel DWM border otherwise inherits the active Windows accent colour.
 // These attributes apply to this HWND only; no registry/system theme changes.
 void ApplyDwmFrameAppearance(){
  // The complete frame is painted as client content. Explicitly keep DWM glass
  // out of that content, including after a compositor restart/session change.
  var margins=new Margins();DwmExtendFrameIntoClientArea(Handle,ref margins);
  SetDwmFrameAttribute(20,lightTheme?0:1,"dark mode");
  if(OperatingSystem.IsWindowsVersionAtLeast(10,0,22000)){
   // Native opt-in only: DWM still owns the radius and maximized/snapped policy.
   SetDwmFrameAttribute(33,2,"corner preference"); // DWMWA_WINDOW_CORNER_PREFERENCE / DWMWCP_ROUND
   // COLORREF is 0x00BBGGRR, not ARGB. Preserve the OS contrast border in HC mode.
   int border=SystemInformation.HighContrast?unchecked((int)0xFFFFFFFF):
    CaptionSurface.R|(CaptionSurface.G<<8)|(CaptionSurface.B<<16);
   SetDwmFrameAttribute(34,border,"border colour"); // DWMWA_BORDER_COLOR
  }
 }
 void SetDwmFrameAttribute(int attribute,int value,string name){
  int result=DwmSetWindowAttribute(Handle,attribute,ref value,sizeof(int));
  if(result<0)System.Diagnostics.Trace.WriteLine($"DWM {name} unavailable: 0x{result:X8}");
 }
 protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);ApplyDwmFrameAppearance();SetWindowPos(Handle,IntPtr.Zero,0,0,0,0,0x0001|0x0002|0x0004|0x0010|0x0020);LayoutCaption();Invalidate(true);}
 protected override void OnDpiChanged(DpiChangedEventArgs e){base.OnDpiChanged(e);LayoutCaption();Invalidate();}
 protected override void OnResize(EventArgs e){base.OnResize(e);LayoutCaption();Invalidate(true);}
 void LayoutCaption(){
  // OnResize may occur during base construction, before field initialization.
  if(CaptionMenu==null||close==null)return;
  // These are client pixels now. Leave the sizing edges outside child HWNDs
  // (including WebView2), so the parent receives their native hit tests.
  bool maximized=WindowState==FormWindowState.Maximized;
  int edgeX=maximized?0:ResizeWidth,edgeY=maximized?0:ResizeHeight;
  Padding=new Padding(edgeX,CaptionHeight,edgeX,edgeY);
  CaptionMenu.SetBounds(Scale(8),0,Math.Min(CaptionMenu.GetPreferredSize(Size.Empty).Width,Math.Max(0,ClientSize.Width-Scale(154))),CaptionHeight);
  int width=Scale(46);close.SetBounds(ClientSize.Width-width,0,width,CaptionHeight);maximize.SetBounds(ClientSize.Width-2*width,0,width,CaptionHeight);minimize.SetBounds(ClientSize.Width-3*width,0,width,CaptionHeight);
  maximize.Restored=WindowState==FormWindowState.Maximized;maximize.AccessibleName=maximize.Restored?"还原":"最大化";maximize.Invalidate();
  CaptionMenu.BringToFront();minimize.BringToFront();maximize.BringToFront();close.BringToFront();
 }
 void ToggleMaximize(){WindowState=WindowState==FormWindowState.Maximized?FormWindowState.Normal:FormWindowState.Maximized;}
 protected override void OnPaintBackground(PaintEventArgs e){using var brush=new SolidBrush(CaptionSurface);e.Graphics.FillRectangle(brush,e.ClipRectangle);}
 protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);using var brush=new SolidBrush(CaptionSurface);e.Graphics.FillRectangle(brush,new Rectangle(0,0,ClientSize.Width,CaptionHeight));}
 protected override bool ProcessCmdKey(ref Message msg,Keys keyData){
  if(keyData==(Keys.Alt|Keys.Space)){ShowSystemMenu(PointToScreen(new Point(Scale(8),CaptionHeight)));return true;}
  return base.ProcessCmdKey(ref msg,keyData);
 }
 void ShowSystemMenu(Point screen){
  var menu=GetSystemMenu(Handle,false);if(menu==IntPtr.Zero)return;
  bool max=IsZoomed(Handle);EnableMenuItem(menu,0xF120,0x0000u|(max?0u:1u));EnableMenuItem(menu,0xF030,0x0000u|(max?1u:0u));EnableMenuItem(menu,0xF000,0x0000u|(max?1u:0u));EnableMenuItem(menu,0xF010,0x0000u|(max?1u:0u));
  int selected=TrackPopupMenu(menu,0x0100|0x0002,screen.X,screen.Y,0,Handle,IntPtr.Zero);
  if(selected!=0)PostMessage(Handle,0x0112,(IntPtr)selected,IntPtr.Zero);
 }
 protected override void WndProc(ref Message m){
  if(m.Msg==0x0085){
   // WM_NCCALCSIZE gives us the whole window. DefWindowProc must not paint
   // WS_THICKFRAME over those client pixels when an overlay deactivates us.
   m.Result=IntPtr.Zero;return; // WM_NCPAINT; all painting belongs to WM_PAINT.
  }
  if(m.Msg==0x0086){
   // Keep the native activation/minimized-icon bookkeeping, but suppress its
   // default frame repaint (documented WM_NCACTIVATE lParam=-1 contract).
   m.LParam=(IntPtr)(-1);base.WndProc(ref m);Invalidate();return;
  }
  if(m.Msg==0x0083){
   // Both NCCALCSIZE_PARAMS.rgrc[0] (TRUE) and RECT (FALSE) start with the
   // proposed window rectangle. Keeping it unchanged makes the entire window
   // client area in both paths. Never mix a DefWindowProc inset with this frame.
   // CS_HREDRAW/CS_VREDRAW and ResizeRedraw invalidate preserved client pixels.
   m.Result=IntPtr.Zero;return;
  }
  if(m.Msg==0x0084){
   m.Result=(IntPtr)HitTestFrame(ScreenPoint(m.LParam));return;
  }
  if(m.Msg==0x00A5&&m.WParam==(IntPtr)2){long pos=m.LParam.ToInt64();ShowSystemMenu(new Point((short)(pos&0xffff),(short)((pos>>16)&0xffff)));m.Result=IntPtr.Zero;return;}
  if(m.Msg==0x0112&&(m.WParam.ToInt64()&0xfff0)==0xF100&&m.LParam==(IntPtr)32){ShowSystemMenu(PointToScreen(new Point(Scale(8),CaptionHeight)));m.Result=IntPtr.Zero;return;}
  base.WndProc(ref m);
  // Reapply per-window colour after a Windows theme/accent/accessibility change.
  if(IsHandleCreated&&(m.Msg==0x031A||m.Msg==0x0320||m.Msg==0x001A||m.Msg==0x031E)){
   SetCaptionTheme(lightTheme,visualStyle);
   // Re-establish the client-frame contract if Windows rebuilt its compositor.
   if(m.Msg==0x031E)SetWindowPos(Handle,IntPtr.Zero,0,0,0,0,0x0001|0x0002|0x0004|0x0010|0x0020);
   Invalidate(true);
  }
  if(m.Msg==0x0024&&m.LParam!=IntPtr.Zero){
   // Preserve DefWindowProc min tracking values and use nearest monitor work area.
   var monitor=MonitorFromWindow(Handle,2);var info=new MonitorInfo{Size=Marshal.SizeOf<MonitorInfo>()};
   if(monitor!=IntPtr.Zero&&GetMonitorInfo(monitor,ref info)){
    var limits=Marshal.PtrToStructure<MinMaxInfo>(m.LParam);
    limits.MaxPosition=new NativePoint{X=info.Work.Left-info.Monitor.Left,Y=info.Work.Top-info.Monitor.Top};
    limits.MaxSize=new NativePoint{X=info.Work.Right-info.Work.Left,Y=info.Work.Bottom-info.Work.Top};
    limits.MinTrackSize.X=Math.Max(limits.MinTrackSize.X,MinimumSize.Width);limits.MinTrackSize.Y=Math.Max(limits.MinTrackSize.Y,MinimumSize.Height);
    Marshal.StructureToPtr(limits,m.LParam,false);
   }
  }
 }
 static Point ScreenPoint(IntPtr packed){long value=packed.ToInt64();return new Point((short)(value&0xffff),(short)((value>>16)&0xffff));}
 int HitTestFrame(Point screen){
  var point=PointToClient(screen);
  if(!ClientRectangle.Contains(point))return 0; // HTNOWHERE; signed screen coordinates support other monitors.
  if(WindowState!=FormWindowState.Maximized){
   bool left=point.X<ResizeWidth,right=point.X>=ClientSize.Width-ResizeWidth;
   bool top=point.Y<ResizeHeight,bottom=point.Y>=ClientSize.Height-ResizeHeight;
   if(top)return left?13:right?14:12;
   if(bottom)return left?16:right?17:15;
   if(left)return 10;if(right)return 11;
  }
  if(point.Y<CaptionHeight&&CaptionMenu!=null&&minimize!=null&&maximize!=null&&close!=null&&
   !CaptionMenu.Bounds.Contains(point)&&!minimize.Bounds.Contains(point)&&!maximize.Bounds.Contains(point)&&!close.Bounds.Contains(point))return 2;
  return 1;
 }
 bool IsResizeHit(Point screen){int hit=HitTestFrame(screen);return hit>=10&&hit<=17;}
 sealed class CaptionMenuStrip:MenuStrip {
  protected override void WndProc(ref Message message){
   // Let the parent size the window at the top/left edge covered by this HWND.
   if(message.Msg==0x0084&&FindForm() is CaptionWindow window&&window.IsResizeHit(ScreenPoint(message.LParam))){message.Result=(IntPtr)(-1);return;}
   base.WndProc(ref message);
  }
 }
 enum CaptionAction {Minimize,Maximize,Close}
 sealed class CaptionButton:Button {
  readonly CaptionAction action;bool hovered;public bool Restored;public bool Light;
  public CaptionButton(CaptionAction action){this.action=action;TabStop=true;AccessibleRole=AccessibleRole.PushButton;FlatStyle=FlatStyle.Flat;FlatAppearance.BorderSize=0;BackColor=Color.FromArgb(24,24,24);ForeColor=Color.White;SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);}
  protected override void OnMouseEnter(EventArgs e){hovered=true;base.OnMouseEnter(e);Invalidate();}
  protected override void OnMouseLeave(EventArgs e){hovered=false;base.OnMouseLeave(e);Invalidate();}
  protected override void WndProc(ref Message message){
   if(message.Msg==0x0084&&FindForm() is CaptionWindow window&&window.IsResizeHit(ScreenPoint(message.LParam))){message.Result=(IntPtr)(-1);return;}
   base.WndProc(ref message);
  }
  protected override void OnPaint(PaintEventArgs e){
   e.Graphics.Clear(hovered?(SystemInformation.HighContrast?SystemColors.Highlight:action==CaptionAction.Close?Color.FromArgb(196,43,28):(Light?Color.FromArgb(225,225,225):Color.FromArgb(48,48,48))):BackColor);
   float scale=DeviceDpi/96f,size=10*scale,x=(Width-size)/2,y=(Height-size)/2;using var pen=new Pen(hovered&&SystemInformation.HighContrast?SystemColors.HighlightText:hovered&&action==CaptionAction.Close?Color.White:ForeColor,Math.Max(1,scale));
   if(action==CaptionAction.Minimize)e.Graphics.DrawLine(pen,x,y+size/2,x+size,y+size/2);
   else if(action==CaptionAction.Close){e.Graphics.DrawLine(pen,x,y,x+size,y+size);e.Graphics.DrawLine(pen,x+size,y,x,y+size);}
   else if(Restored){float d=3*scale;e.Graphics.DrawLines(pen,new[]{new PointF(x+d,y),new PointF(x+size,y),new PointF(x+size,y+size-d)});e.Graphics.DrawRectangle(pen,x,y+d,size-d,size-d);}
   else e.Graphics.DrawRectangle(pen,x,y,size,size);
   if(Focused&&ShowFocusCues)ControlPaint.DrawFocusRectangle(e.Graphics,Rectangle.Inflate(ClientRectangle,-4,-4),ForeColor,BackColor);
  }
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


 [StructLayout(LayoutKind.Sequential)]struct Rect{public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)]struct Margins{public int Left,Right,Top,Bottom;}
 [StructLayout(LayoutKind.Sequential)]struct NativePoint{public int X,Y;}
 [StructLayout(LayoutKind.Sequential)]struct MinMaxInfo{public NativePoint Reserved,MaxSize,MaxPosition,MinTrackSize,MaxTrackSize;}
 [StructLayout(LayoutKind.Sequential)]struct MonitorInfo{public int Size;public Rect Monitor,Work;public uint Flags;}
 [DllImport("dwmapi.dll")]static extern int DwmSetWindowAttribute(IntPtr hwnd,int attribute,ref int value,int size);
 [DllImport("dwmapi.dll")]static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd,ref Margins margins);
 [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool IsZoomed(IntPtr hwnd);
 [DllImport("user32.dll")]static extern IntPtr GetSystemMenu(IntPtr hwnd,[MarshalAs(UnmanagedType.Bool)]bool revert);
 [DllImport("user32.dll")]static extern uint EnableMenuItem(IntPtr menu,uint item,uint flags);
 [DllImport("user32.dll")]static extern int TrackPopupMenu(IntPtr menu,uint flags,int x,int y,int reserved,IntPtr hwnd,IntPtr rect);
 [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool PostMessage(IntPtr hwnd,int message,IntPtr wparam,IntPtr lparam);
 [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
 [DllImport("user32.dll")]static extern IntPtr MonitorFromWindow(IntPtr hwnd,uint flags);
 [DllImport("user32.dll")]static extern int GetSystemMetricsForDpi(int index,uint dpi);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)][return:MarshalAs(UnmanagedType.Bool)]static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
}
