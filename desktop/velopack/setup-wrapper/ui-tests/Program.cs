using System;using System.IO;using System.Linq;using System.Reflection;using System.Drawing;using System.Windows.Forms;
internal static class UiTests {
 static int checks;
 static void A(bool value,string message){if(!value)throw new Exception(message);checks++;}
 [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window,int message,IntPtr key,IntPtr data);
 static System.Collections.Generic.IEnumerable<Control> All(Control root){foreach(Control c in root.Controls){yield return c;foreach(var child in All(c))yield return child;}}
 [STAThread] static int Main(string[] args){
  Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
  // Compile the exact production form source; no dynamic assembly loading.
  Directory.CreateDirectory(args[0]);
  foreach(float scale in new[]{1f,1.25f,1.5f,2f})using(var form=new CodexLight.SetupWrapper.SetupForm()){
   A(form.Text=="安装 码舱 CodeCang","brand title");form.ShowInTaskbar=false;form.StartPosition=FormStartPosition.Manual;form.Location=new Point(-32000,-32000);form.Opacity=0;form.Show();
   form.CreateControl();form.PerformLayout();if(scale!=1)form.Scale(new SizeF(scale,scale));form.PerformLayout();
   var controls=All(form).ToArray();A(controls.OfType<Button>().Count()==2,"two explicit actions");
   var consent=controls.OfType<CodexLight.Shared.ToggleSwitch>().Single();
   A(!consent.Checked,"consent defaults off");
   A(consent.TabStop && consent.AccessibilityObject.Name==consent.Text && consent.AccessibilityObject.Role==AccessibleRole.CheckButton,"labeled native toggle semantics");
   SendMessage(consent.Handle,0x0100,(IntPtr)Keys.Space,IntPtr.Zero);
   SendMessage(consent.Handle,0x0101,(IntPtr)Keys.Space,IntPtr.Zero);
   A(consent.Checked && (consent.AccessibilityObject.State & AccessibleStates.Checked)!=0,"Space changes the state exposed to screen readers");
   consent.AccessibilityObject.DoDefaultAction();
   A(!consent.Checked,"assistive technology can switch consent back off");
   A(controls.OfType<Button>().Any(b=>b.Text=="取消下载"&&!b.Enabled),"download inactive");
   foreach(var c in controls){A(!c.Text.Contains("Codex Light"),"old visible brand");if(c is Button||c is CheckBox){A(c.Width>0&&c.Height>0,"nonempty control");A(c.Right<=c.Parent.ClientSize.Width&&c.Bottom<=c.Parent.ClientSize.Height,"control inside parent");}}
   using(var image=new Bitmap(form.Width,form.Height)){form.DrawToBitmap(image,new Rectangle(Point.Empty,image.Size));image.Save(Path.Combine(args[0],"fresh-"+(int)(scale*100)+".png"));}
  }
  Console.WriteLine("PASS "+checks+" actual WinForms offscreen brand/layout assertions. No visible foreground UI or Start/process/install/registry action; synthetic scale is not actual monitor DPI.");return 0;
 }
}
