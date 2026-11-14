using CodexLight.Desktop;using System.Drawing.Imaging;using System.Reflection;
static class Program{
 static int checks;static void Check(bool value,string name){checks++;if(!value)throw new Exception(name);}
 [STAThread]static void Main(string[] args){
  string output=args.Length>0?args[0]:Path.Combine(Path.GetTempPath(),"codex-startup-previews");Directory.CreateDirectory(output);
  bool motion=false;using var view=new StartupView(()=>motion);view.Size=new Size(800,600);using var hiddenHost=new Form{ShowInTaskbar=false};hiddenHost.Controls.Add(view);_ = hiddenHost.Handle;_ = view.Handle;
  Check(!view.AnimationRunning,"reduced motion disables timer");Check(view.Phase==StartupPhase.Environment,"starts with real environment stage");
  foreach(var phase in Enum.GetValues<StartupPhase>()){view.SetProgress(phase,"正在检查 "+phase);Check(view.Phase==phase,"stage follows callback only");Check(view.AccessibleDescription!.Contains(phase.ToString()),"screen reader receives actual detail");}
  view.SetProgress(StartupPhase.Renderer,"正在启动 WebView2 142.0 · 系统运行时");
  foreach(var item in new[]{("dark",new Size(1257,900),1f,false),("compact",new Size(800,600),1f,false),("light",new Size(1000,700),1f,true),("dpi200",new Size(1600,1200),2f,false)}){
   view.BackColor=item.Item4?Color.White:Color.FromArgb(24,24,24);view.ForeColor=item.Item4?Color.FromArgb(32,32,32):Color.FromArgb(236,236,236);
   using var image=new Bitmap(item.Item2.Width,item.Item2.Height);using var g=Graphics.FromImage(image);view.Render(g,item.Item2,item.Item3,1,30);image.Save(Path.Combine(output,item.Item1+".png"),ImageFormat.Png);Check(image.GetPixel(0,0).ToArgb()==view.BackColor.ToArgb(),"clean full canvas");
  }
  Check(StartupView.ShouldAnimate(true,true,false,true),"normal visible startup animates");
  foreach(var flags in new[]{(false,true,false,true),(true,false,false,true),(true,true,true,true),(true,true,false,false)})Check(!StartupView.ShouldAnimate(flags.Item1,flags.Item2,flags.Item3,flags.Item4),"hidden/failed/reduced startup never animates");
  motion=true;typeof(StartupView).GetMethod("RefreshAnimation",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(view,null);Check(!view.AnimationRunning,"hidden host never starts timer");
  using(var image=new Bitmap(800,600)){using var g=Graphics.FromImage(image);view.Render(g,image.Size,1,.35,30);image.Save(Path.Combine(output,"entrance-frame.png"),ImageFormat.Png);}
  const string failure="WebView2 无法启动。请检查应用数据目录权限。\r\n错误：UnauthorizedAccessException · 0x80070005\r\n不会自动重发任务；请检查后重新打开。";view.ShowFailure(failure);Check(view.HasFailed&&!view.AnimationRunning,"failure stops animation");Check(view.Controls.OfType<TextBox>().Single().Text==failure,"full diagnostics remain selectable, not truncated");view.SetProgress(StartupPhase.Interface,"not ready");Check(view.Phase==StartupPhase.Renderer,"failure cannot turn into fake progress");
  using(var image=new Bitmap(800,600)){using var g=Graphics.FromImage(image);view.Render(g,image.Size,1,1,0);image.Save(Path.Combine(output,"failure.png"),ImageFormat.Png);}
  Console.WriteLine($"Passed {checks} startup checks; no app/backend/model launched. Previews: {output}");
 }
}
