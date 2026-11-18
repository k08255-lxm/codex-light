using System.Reflection;
using System.Runtime.InteropServices;
using CodexLight.Desktop;

internal static class Program {
 [STAThread] static int Main(string[] args){
  ApplicationConfiguration.Initialize();
  using var window=new TestWindow();
  CheckMessages(window.Badge);
  CheckIcons();
  Console.WriteLine("PASS: taskbar badge validation, 16/24/32 px rendering and native HICON alpha");
  if(args.Contains("--preview"))BadgePreview.Save();
  bool checkFocus=args.Contains("--shell");
  bool capture=args.Contains("--shell-preview");
  if(!checkFocus&&!capture&&!args.Contains("--shell-overlay"))return 0;

  using var brand=capture?new Icon("desktop/app.ico"):null;
  if(brand!=null)window.Icon=brand;

  Exception? failure=null;
  window.Shown+=async(_,_)=>{
   try{
    await CheckShellAsync(window,checkFocus);
    if(capture)await CaptureShellAsync(window.Badge);
   }
   catch(Exception error){failure=error;}
   finally{window.Close();}
  };
  Application.Run(window);
  if(failure!=null){Console.Error.WriteLine(failure);return 1;}
  return 0;
 }

 static async Task CaptureShellAsync(TaskbarBadge badge){
  async Task<Bitmap> Capture(ulong count){
   Set(badge,count,false);
   await WaitForAsync(()=>Overlay(badge)?.Count==count,"native overlay before screenshot");
   await Task.Delay(650);
   return BadgePreview.CaptureTaskbar();
  }
  using var empty=await Capture(0);
  using var twoDigits=await Capture(12);
  using var capped=await Capture(100);
  BadgePreview.SaveExplorer(empty,twoDigits,capped);
 }

 static void CheckMessages(TaskbarBadge badge){
  Require(!badge.HandleMessage("{}",true),"Unknown operation consumed");
  Require(!badge.HandleMessage("{\"type\":123}",true),"Invalid type consumed");
  Require(!badge.HandleMessage("{",true),"Invalid JSON consumed");
  Set(badge,99,false);
  foreach(string input in new[]{"-1","1.5","\"1\"","null","1,\"extra\":true"}){
   Require(badge.HandleMessage($$"""{"type":"desktopTaskbarBadge","count":{{input}},"attention":true}""",true),"Badge message was not consumed");
   Require(State(badge)==(99UL,false),"Invalid count changed badge");
  }
  badge.HandleMessage("""{"type":"desktopTaskbarBadge","count":2,"attention":"true"}""",true);
  badge.HandleMessage("""{"type":"desktopTaskbarBadge","count":2,"attention":true}""",false);
  Require(State(badge)==(99UL,false),"Invalid or disabled attention changed badge");
  Set(badge,ulong.MaxValue,true);
  Require(State(badge)==(ulong.MaxValue,true),"Large count or attention lost");
  Set(badge,0,true);
  Require(State(badge)==(0UL,false),"Zero did not clear attention");
 }

 static void CheckIcons(){
  foreach(int size in new[]{16,24,32}){
   using var single=TaskbarBadge.DrawBadge(1,size,Color.DarkRed,Color.White);
   using var doubleDigits=TaskbarBadge.DrawBadge(99,size,Color.DarkRed,Color.White);
   using var capped=TaskbarBadge.DrawBadge(100,size,Color.DarkRed,Color.White);
   using var thousands=TaskbarBadge.DrawBadge(1_234,size,Color.DarkRed,Color.White);
   Require(capped.Size==new Size(size,size)&&capped.GetPixel(0,0).A==0,"Incorrect icon size or transparency");
   Require(!EqualPixels(single,doubleDigits)&&!EqualPixels(doubleDigits,capped),"Badge labels use the same pixels");
   Require(!EqualPixels(capped,thousands),"Three digits and thousands must be distinguishable");
   Require(TaskbarBadge.CounterText(999)=="999"&&TaskbarBadge.CounterText(1_234)=="1K"&&TaskbarBadge.CounterText(2_000_000)=="2M","Counter abbreviations");
   BadgePreview.VerifyNativeIcon(size);
  }
 }

 static bool EqualPixels(Bitmap first,Bitmap second){
  for(int y=0;y<first.Height;y++)for(int x=0;x<first.Width;x++)
   if(first.GetPixel(x,y)!=second.GetPixel(x,y))return false;
  return true;
 }

 static async Task CheckShellAsync(TestWindow window,bool checkFocus){
  var badge=window.Badge;
  Set(badge,100,false);
  await WaitForAsync(()=>Overlay(badge)?.Count==100,"native three-digit overlay after TaskbarButtonCreated");
  window.Hide();
  Require(Overlay(badge)==null,"Hidden button retained overlay cache");
  Set(badge,7,false);
  window.Show();
  await WaitForAsync(()=>Overlay(badge)?.Count==7,"shown taskbar button restores unread count");
  window.RecreateButton();
  await WaitForAsync(()=>Overlay(badge)?.Count==7,"new HWND restores unread count");
  Set(badge,0,false);
  Require(Overlay(badge)?.Count==0&&!Flash(badge),"Clearing unread did not clear the overlay");
  Console.WriteLine("PASS: real taskbar button, count restore after hide and HWND recreation, and clear");
  if(!checkFocus)return;

  window.Activate();
  await WaitForAsync(()=>GetForegroundWindow()==window.Handle,"test window foreground");
  Set(badge,100,true);
  Require(!Flash(badge),"Foreground badge flashed");

  using var other=new Form{Text="Taskbar badge focus test",ShowInTaskbar=false};
  other.Show();other.Activate();
  await WaitForAsync(()=>GetForegroundWindow()==other.Handle&&Flash(badge),"background attention");
  Set(badge,101,true);
  Require(Flash(badge)&&GetForegroundWindow()==other.Handle,"Repeated state changed focus or stopped flash");
  window.Activate();
  await WaitForAsync(()=>GetForegroundWindow()==window.Handle&&!Flash(badge),"attention stops on activation");
  window.WindowState=FormWindowState.Minimized;
  await WaitForAsync(()=>Flash(badge),"pending attention restarts after minimizing");
  Set(badge,101,false);
  Require(!Flash(badge)&&Overlay(badge)?.Count==101,"Disabling attention did not preserve the overlay");
  Console.WriteLine("PASS: foreground, background, minimize and attention disable transitions");
 }

 static async Task WaitForAsync(Func<bool> condition,string description){
  for(int attempt=0;attempt<100;attempt++){
   if(condition())return;
   await Task.Delay(50);
  }
  throw new TimeoutException(description);
 }

 static void Set(TaskbarBadge badge,ulong count,bool attention)=>
  Require(badge.HandleMessage($$"""{"type":"desktopTaskbarBadge","count":{{count}},"attention":{{(attention?"true":"false")}}}""",true),"Badge message was not consumed");
 static T Read<T>(TaskbarBadge badge,string name)=>(T)typeof(TaskbarBadge).GetField(name,BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(badge)!;
 static (ulong Count,bool Attention) State(TaskbarBadge badge)=>Read<(ulong,bool)>(badge,"state");
 static (ulong Count,int Size,Color Fill,Color Ink)? Overlay(TaskbarBadge badge)=>Read<(ulong,int,Color,Color)?>(badge,"appliedOverlay");
 static bool Flash(TaskbarBadge badge)=>Read<bool>(badge,"flashing");
 static void Require(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();

 sealed class TestWindow : Form {
  internal TaskbarBadge Badge{get;}
  internal TestWindow(){Badge=new(this);Text="Taskbar badge test";Width=420;Height=230;}
  internal void RecreateButton()=>RecreateHandle();
  protected override void WndProc(ref Message message){base.WndProc(ref message);Badge?.ObserveWindowMessage(message);}
  protected override void Dispose(bool disposing){if(disposing)Badge.Dispose();base.Dispose(disposing);}
 }
}
