using Microsoft.Win32;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace CodexLight.Desktop;

// The notification area is a system surface, not the app's selected colour theme.
internal static class TrayAppearance {
 internal static bool IsLightTaskbar() {
  if(SystemInformation.HighContrast)return SystemColors.Window.GetBrightness()>0.5f;
  try{return Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize","SystemUsesLightTheme",0) is int value&&value==1;}
  catch(System.Security.SecurityException){return false;}
  catch(UnauthorizedAccessException){return false;}
 }
 internal static Icon CreateIcon(int size,bool light) {
  using var bitmap=new Bitmap(size,size,System.Drawing.Imaging.PixelFormat.Format32bppArgb);
  using var graphics=Graphics.FromImage(bitmap);
  graphics.Clear(Color.Transparent);graphics.SmoothingMode=SmoothingMode.AntiAlias;
  graphics.ScaleTransform(size/16f,size/16f);
  Color ink=SystemInformation.HighContrast?SystemColors.WindowText:light?Color.FromArgb(45,45,45):Color.FromArgb(242,242,242);
  using var pen=new Pen(ink,1.75f){StartCap=LineCap.Round,EndCap=LineCap.Round};
  // Preserve the aperture identity without the rounded tile or tiny coloured dot.
  graphics.DrawArc(pen,2.5f,2.5f,11,11,42,276);
  using var dot=new SolidBrush(ink);graphics.FillEllipse(dot,12,7,2,2);
  IntPtr handle=bitmap.GetHicon();
  try{using var borrowed=Icon.FromHandle(handle);return (Icon)borrowed.Clone();}
  finally{DestroyIcon(handle);}
 }
 internal static void Apply(ContextMenuStrip menu,bool light) {
  var surface=SystemInformation.HighContrast?SystemColors.Menu:light?Color.FromArgb(250,250,250):Color.FromArgb(32,32,32);
  var ink=SystemInformation.HighContrast?SystemColors.MenuText:light?Color.FromArgb(35,35,35):Color.FromArgb(235,235,235);
  menu.BackColor=surface;menu.ForeColor=ink;
  menu.ShowImageMargin=false;menu.ShowCheckMargin=false;menu.Padding=new Padding(4);
  menu.Renderer=SystemInformation.HighContrast?new ToolStripSystemRenderer():new FlatMenuRenderer(light);
  foreach(ToolStripItem item in menu.Items){item.ForeColor=ink;if(item is ToolStripMenuItem){item.Padding=new Padding(12,6,12,6);}}
 }
 sealed class FlatMenuRenderer(bool light):ToolStripProfessionalRenderer(new FlatMenuColors(light)) {
  protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) {
   if(!e.Item.Selected&&!e.Item.Pressed)return;
   using var brush=new SolidBrush(light?Color.FromArgb(232,232,232):Color.FromArgb(55,55,55));
   e.Graphics.FillRectangle(brush,new Rectangle(0,0,e.Item.Width,e.Item.Height));
  }
 }
 sealed class FlatMenuColors(bool light):ProfessionalColorTable {
  Color Surface=>light?Color.FromArgb(250,250,250):Color.FromArgb(32,32,32);
  Color Border=>light?Color.FromArgb(218,218,218):Color.FromArgb(64,64,64);
  public override Color ToolStripDropDownBackground=>Surface;
  public override Color MenuBorder=>Border;
  public override Color SeparatorDark=>Border;
  public override Color SeparatorLight=>Surface;
 }
 [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool DestroyIcon(IntPtr handle);
}
