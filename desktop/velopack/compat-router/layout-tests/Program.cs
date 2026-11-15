using System;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;
using CodexLight.PublicSetup;

// No fixture can download or launch an installer: the tests only construct/layout
// the form and toggle its progress control. No Continue click is performed.
namespace CodexLight.PublicSetup {
 internal static class Pins { internal const string Version="0.4.6",FreshHash="",FreshUrl=""; }
}
internal static class LayoutTests {
 [System.Runtime.InteropServices.DllImport("shcore.dll")] static extern int GetProcessDpiAwareness(IntPtr process,out int awareness);
 [STAThread] static int Main() {
  int awareness; if(GetProcessDpiAwareness(IntPtr.Zero,out awareness)!=0||awareness!=1)throw new Exception("Embedded system-DPI awareness missing");
  Console.WriteLine("PASS embedded manifest: process is system DPI-aware, not bitmap virtualized");
  Application.EnableVisualStyles();
  Application.SetCompatibleTextRenderingDefault(false);
  try {
   foreach(float scale in new[]{1f,1.25f,1.5f,1.75f,2f}) {
    using(var form=new RouterWindow()) {
     form.StartPosition=FormStartPosition.Manual;
     form.Location=new Point(-30000,-30000);
     form.ShowInTaskbar=false;
     form.Show();
     if(scale!=1f)form.Scale(new SizeF(scale,scale));
     var panel=(TableLayoutPanel)form.Controls[0];
     var actions=panel.Controls.OfType<FlowLayoutPanel>().Single();
     var progress=panel.Controls.OfType<ProgressBar>().Single();
     if(panel.GetRow(actions)!=3||panel.GetRow(progress)!=2)
      throw new Exception("Controls do not retain their explicit rows");
     foreach(bool visible in new[]{false,true,false,true,false}) {
      progress.Visible=visible;
      form.PerformLayout();panel.PerformLayout();actions.PerformLayout();
      Application.DoEvents();
      Check(form,panel,actions);
     }
     form.ClientSize=new Size((int)(600*scale),(int)(330*scale)); form.PerformLayout();panel.PerformLayout();actions.PerformLayout();
     Application.DoEvents();
     Check(form,panel,actions);
     if(form.AcceptButton==null||form.CancelButton==null)throw new Exception("Keyboard action missing");
     Console.WriteLine("PASS layout scale "+scale+": initial, busy, completion, repeat and narrow window");
     form.Close();
    }
   }
   Console.WriteLine("No Continue clicked; no download, installation, registry or user configuration changed.");
   return 0;
  }catch(Exception e){Console.Error.WriteLine(e);return 1;}
 }
 static void Check(Form form,TableLayoutPanel panel,FlowLayoutPanel actions) {
  if(!form.ClientRectangle.Contains(actions.Bounds))throw new Exception("Action row outside client: "+actions.Bounds+" / "+form.ClientRectangle);
  var buttons=actions.Controls.OfType<Button>().ToArray();
  if(buttons.Length!=2)throw new Exception("Missing action buttons");
  foreach(var button in buttons) {
   if(!button.Visible||!actions.ClientRectangle.Contains(button.Bounds))
    throw new Exception("Button clipped: "+button.Bounds+" in "+actions.ClientRectangle);
   var bounds= form.RectangleToClient(button.RectangleToScreen(button.ClientRectangle));
   if(!form.ClientRectangle.Contains(bounds))throw new Exception("Button outside form");
  }
  if(buttons[0].Bounds.IntersectsWith(buttons[1].Bounds))throw new Exception("Buttons overlap");
 }
}


