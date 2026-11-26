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
   var hwnd=Handle(window,"window");var close=Handle(window,"close");var heading=Handle(window,"heading");var body=Handle(window,"body");var bar=Handle(window,"bar");
   var openApp=Handle(window,"openApp");int launches=0;
   Check(!IsWindowVisible(openApp),"Open must stay hidden until verification succeeds");
   SendMessageW(hwnd,0x111,(IntPtr)104,openApp);
   Check(!IsWindowEnabled(close),"Close must remain disabled during apply");
   SendMessageW(hwnd,0x10,IntPtr.Zero,IntPtr.Zero);Check(IsWindow(hwnd),"Busy close cannot terminate update UI");
   window.Report("正在安装更新");Wait(()=>Text(heading)=="正在安装更新");
   Check(IsWindowVisible(bar)&&(GetWindowLongW(bar,-16)&8)!=0,"Unknown progress must show the marquee");
   window.ReportVerification(3,10);
   Wait(()=>Text(heading)=="正在校验安装文件…"&&Text(body)=="已校验 3 / 10 个文件。"&&SendMessageW(bar,0x408,IntPtr.Zero,IntPtr.Zero)==(IntPtr)30);
   Check(IsWindowVisible(bar)&&(GetWindowLongW(bar,-16)&8)==0,"Known progress must show a determinate bar");
   Thread.Sleep(150);
   if(i==0)Capture.Save(hwnd,Path.Combine(AppContext.BaseDirectory,"progress-check.bmp"));
   string diagnostic="模拟结果：未运行更新器，也未修改正式安装。\r\n"+new string('测',1000);
   window.Complete(i%2==0,diagnostic,()=>{launches++;if(i==2&&launches==1)throw new IOException("fixture launch failed");});Wait(()=>IsWindowEnabled(close));
   Thread.Sleep(150);
   if(i==1)Capture.Save(hwnd,Path.Combine(AppContext.BaseDirectory,"progress-error.bmp"));
   Check(Text(body)==diagnostic,"Long diagnostics truncated");Check(Text(heading)==(i%2==0?"更新已完成":"更新未完成"),"Terminal status incorrect");
   Check(Text(hwnd).StartsWith(Text(heading)),"Taskbar title missing outcome");
   Check(!IsWindowVisible(bar),"Terminal status must hide the progress bar");
   window.Report("must not overwrite terminal state");window.Complete(i%2!=0,"late completion");Thread.Sleep(50);Check(Text(body)==diagnostic,"Terminal result overwritten");
   Check(IsWindowVisible(openApp)==(i%2==0),"Open action must be success-only");
   SendMessageW(hwnd,0x111,(IntPtr)104,openApp);
   if(i==1){Check(launches==0,"Failure launched app");SendMessageW(hwnd,0x10,IntPtr.Zero,IntPtr.Zero);}
   if(i==2){Check(Text(body).Contains("fixture launch failed")&&IsWindowEnabled(openApp),"Launch failure must be retryable");SendMessageW(hwnd,0x111,(IntPtr)104,openApp);}
   window.WaitForClose();
   Check(launches==(i==1?0:i==2?2:1),"Unexpected launch count");
  }
  Console.WriteLine("PASS native hidden progress: 3 loops; real window/control states, busy-close veto, stages, success/failure, 1000-character diagnostics, final close/disposal. No updater, installed app or user configuration touched.");
 }
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowTextW(IntPtr h,StringBuilder text,int count);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern int GetWindowLongW(IntPtr h,int index);
 [DllImport("user32.dll")]static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr SendMessageW(IntPtr h,uint m,IntPtr w,IntPtr l);
}
