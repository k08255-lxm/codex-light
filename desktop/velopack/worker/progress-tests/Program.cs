using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using CodexLight.Desktop;
internal static class Tests {
 static IntPtr Handle(BootstrapProgress p,string name)=>(IntPtr)typeof(BootstrapProgress).GetField(name,BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(p)!;
 static string Text(IntPtr h){var b=new StringBuilder(4096);GetWindowTextW(h,b,b.Capacity);return b.ToString();}
 static void Check(bool ok,string message){if(!ok)throw new Exception(message);}
 static void Wait(Func<bool> condition){Check(SpinWait.SpinUntil(condition,2000),"UI did not reach expected state");}
 static void Main(){
  for(int i=0;i<3;i++){
   using var window=BootstrapProgress.Start(false);
   var hwnd=Handle(window,"window");var close=Handle(window,"close");var heading=Handle(window,"heading");var body=Handle(window,"body");
   Check(!IsWindowEnabled(close),"Close must remain disabled during apply");
   SendMessageW(hwnd,0x10,IntPtr.Zero,IntPtr.Zero);Check(IsWindow(hwnd),"Busy close cannot terminate update UI");
   window.Report("正在安装更新");Wait(()=>Text(heading)=="正在安装更新");
   window.Report("正在核对安装文件");Wait(()=>Text(heading)=="正在核对安装文件");
   Thread.Sleep(150);
   if(i==0)Capture.Save(hwnd,Path.Combine(AppContext.BaseDirectory,"progress-check.bmp"));
   string diagnostic="模拟结果：未运行更新器，也未修改正式安装。\r\n"+new string('测',1000);
   window.Complete(i%2==0,diagnostic);Wait(()=>IsWindowEnabled(close));
   Thread.Sleep(150);
   if(i==1)Capture.Save(hwnd,Path.Combine(AppContext.BaseDirectory,"progress-error.bmp"));
   Check(Text(body)==diagnostic,"Long diagnostics truncated");Check(Text(heading)==(i%2==0?"更新已完成":"更新未完成"),"Terminal status incorrect");
   window.Report("must not overwrite terminal state");Thread.Sleep(50);Check(Text(body)==diagnostic,"Terminal result overwritten");
   SendMessageW(hwnd,0x10,IntPtr.Zero,IntPtr.Zero);window.WaitForClose();
  }
  Console.WriteLine("PASS native hidden progress: 3 loops; real window/control states, busy-close veto, stages, success/failure, 1000-character diagnostics, final close/disposal. No updater, installed app or user configuration touched.");
 }
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowTextW(IntPtr h,StringBuilder text,int count);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr SendMessageW(IntPtr h,uint m,IntPtr w,IntPtr l);
}
