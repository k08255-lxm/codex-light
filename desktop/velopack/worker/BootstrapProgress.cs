using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
namespace CodexLight.Desktop;

// A dedicated native message loop keeps progress visible while
// the worker waits for parent exit and Update.exe. No additional UI runtime.
internal sealed class BootstrapProgress : IDisposable {
 const uint RefreshMessage=0x8001,StopMessage=0x8002;
 readonly Thread thread; readonly ManualResetEventSlim ready=new(false);
 readonly object gate=new(); readonly bool visible;
 IntPtr window,heading,body,bar,close,font,headingFont; Exception? startupError;
 string phase="正在准备更新…",message="更新正在进行，请不要关闭电脑。";
 int? verifiedPercent;
 bool completed,disposed; readonly WindowProc callback;
 BootstrapProgress(bool visible){this.visible=visible;callback=Handle;thread=new Thread(Run){IsBackground=true,Name="CodeCang update progress"};thread.SetApartmentState(ApartmentState.STA);thread.Start();if(!ready.Wait(TimeSpan.FromSeconds(10))){lock(gate){disposed=true;}if(window!=IntPtr.Zero)PostMessageW(window,StopMessage,IntPtr.Zero,IntPtr.Zero);throw new TimeoutException("Update progress window did not start.");}if(startupError!=null)throw new InvalidOperationException("Cannot display update progress.",startupError);}
 internal static BootstrapProgress Start(bool visible=true)=>new(visible);
 internal void Report(string text,string detail="更新正在进行，请不要关闭电脑。",int? percent=null){
  lock(gate){if(completed||disposed)return;phase=text;message=detail;verifiedPercent=percent;}
  PostMessageW(window,RefreshMessage,IntPtr.Zero,IntPtr.Zero);
 }
 internal void ReportVerification(int verified,int total)=>
  Report("正在校验安装文件…",$"已校验 {verified:N0} / {total:N0} 个文件。",total==0?null:(int)(100L*verified/total));
 internal void Complete(bool success,string text){lock(gate){if(completed||disposed)return;completed=true;phase=success?"更新已完成":"更新未完成";message=text;}PostMessageW(window,RefreshMessage,IntPtr.Zero,IntPtr.Zero);}
 internal void WaitForClose(){if(Thread.CurrentThread!=thread)thread.Join();}
 public void Dispose(){lock(gate){if(disposed)return;disposed=true;}if(window!=IntPtr.Zero)PostMessageW(window,StopMessage,IntPtr.Zero,IntPtr.Zero);if(Thread.CurrentThread!=thread)thread.Join(TimeSpan.FromSeconds(5));}
 void Run(){
  try{
   var init=new InitControls{Size=(uint)Marshal.SizeOf<InitControls>(),Classes=0x20};if(!InitCommonControlsEx(ref init))throw new Win32Exception();
   string name="CodeCang.Update.Progress."+Environment.ProcessId;
   var wc=new WindowClass{Size=(uint)Marshal.SizeOf<WindowClass>(),Proc=callback,Instance=GetModuleHandleW(null),Cursor=LoadCursorW(IntPtr.Zero,(IntPtr)32512),Background=(IntPtr)6,Name=name};
   if(RegisterClassExW(ref wc)==0)throw new Win32Exception();
   int dpi=(int)GetDpiForSystem();int S(int n)=>n*dpi/96;
   window=CreateWindowExW(visible?0u:0x80u,name,"码舱 CodeCang 更新",0x00CA0000,visible?int.MinValue:-30000,visible?int.MinValue:-30000,S(600),S(320),IntPtr.Zero,IntPtr.Zero,wc.Instance,IntPtr.Zero);
   if(window==IntPtr.Zero)throw new Win32Exception();
   font=CreateFontW(-S(16),0,0,0,400,0,0,0,1,0,0,5,0,"Microsoft YaHei UI");if(font==IntPtr.Zero)font=GetStockObject(17);
   heading=Control("STATIC","",0,100);body=Control("EDIT","",0x00200844,101);bar=Control("msctls_progress32","",8,102);close=Control("BUTTON","关闭",0x10000,103);
   headingFont=CreateFontW(-S(22),0,0,0,600,0,0,0,1,0,0,5,0,"Microsoft YaHei UI");
   foreach(var h in new[]{body,close})SendMessageW(h,0x30,font,(IntPtr)1);
   SendMessageW(heading,0x30,headingFont==IntPtr.Zero?font:headingFont,(IntPtr)1);
   EnableWindow(close,false);SendMessageW(bar,0x40A,(IntPtr)1,(IntPtr)35);
   Layout();Render();lock(gate){if(disposed){DestroyWindow(window);ready.Set();return;}}ShowWindow(window,visible?5:4);ready.Set();
   while(GetMessageW(out var msg,IntPtr.Zero,0,0)>0){if(!IsDialogMessageW(window,ref msg)){TranslateMessage(ref msg);DispatchMessageW(ref msg);}}
   UnregisterClassW(name,wc.Instance);
  }catch(Exception e){startupError=e;ready.Set();}finally{if(window!=IntPtr.Zero)DestroyWindow(window);if(headingFont!=IntPtr.Zero)DeleteObject(headingFont);if(font!=IntPtr.Zero&&font!=GetStockObject(17))DeleteObject(font);window=IntPtr.Zero;}
 }
 IntPtr Control(string type,string text,uint style,int id){var h=CreateWindowExW(0,type,text,0x50000000|style,0,0,0,0,window,(IntPtr)id,GetModuleHandleW(null),IntPtr.Zero);if(h==IntPtr.Zero)throw new Win32Exception();return h;}
 void Layout(){if(body==IntPtr.Zero)return;GetClientRect(window,out var r);int d=(int)GetDpiForSystem();int S(int n)=>n*d/96;int w=r.Right;int h=r.Bottom;MoveWindow(heading,S(28),S(25),w-S(56),S(30),true);MoveWindow(body,S(28),S(65),w-S(56),Math.Max(S(50),h-S(145)),true);MoveWindow(bar,S(28),h-S(70),w-S(56),S(6),true);MoveWindow(close,w-S(132),h-S(52),S(104),S(34),true);}
 void Render(){
  string p,m;bool done;int? percent;
  lock(gate){p=phase;m=message;done=completed;percent=verifiedPercent;}
  SetWindowTextW(window,p+" · 码舱 CodeCang");SetWindowTextW(heading,p);SetWindowTextW(body,m);
  ShowScrollBar(body,1,done&&m.Length>400);EnableWindow(close,done);
  const int styleIndex=-16,marqueeStyle=8;
  const uint setMarquee=0x40A,setPosition=0x402;
  if(done){SendMessageW(bar,setMarquee,IntPtr.Zero,IntPtr.Zero);ShowWindow(bar,0);SetFocus(close);return;}
  int style=GetWindowLongW(bar,styleIndex);
  bool marquee=(style&marqueeStyle)!=0;
  if(percent.HasValue){
   if(marquee){SendMessageW(bar,setMarquee,IntPtr.Zero,IntPtr.Zero);SetWindowLongW(bar,styleIndex,style&~marqueeStyle);}
   SendMessageW(bar,setPosition,(IntPtr)percent.Value,IntPtr.Zero);
  }else if(!marquee){
   SetWindowLongW(bar,styleIndex,style|marqueeStyle);SendMessageW(bar,setMarquee,(IntPtr)1,(IntPtr)35);
  }
 }
 IntPtr Handle(IntPtr hwnd,uint msg,IntPtr wp,IntPtr lp){switch(msg){case 0x138:SetBkColor(wp,GetSysColor(5));SetTextColor(wp,GetSysColor(8));return GetSysColorBrush(5);case RefreshMessage:Render();return IntPtr.Zero;case StopMessage:DestroyWindow(hwnd);return IntPtr.Zero;case 0x10:lock(gate){if(!completed)return IntPtr.Zero;}DestroyWindow(hwnd);return IntPtr.Zero;case 0x111:if((wp.ToInt64()&0xffff)==103){lock(gate){if(completed)DestroyWindow(hwnd);}return IntPtr.Zero;}break;case 5:Layout();break;case 2:PostQuitMessage(0);return IntPtr.Zero;}return DefWindowProcW(hwnd,msg,wp,lp);}
 delegate IntPtr WindowProc(IntPtr hwnd,uint message,IntPtr wp,IntPtr lp);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct WindowClass{public uint Size,Style;public WindowProc Proc;public int ClassExtra,WindowExtra;public IntPtr Instance,Icon,Cursor,Background;public string? Menu;public string Name;public IntPtr SmallIcon;}
 [StructLayout(LayoutKind.Sequential)]struct InitControls{public uint Size,Classes;}
 [StructLayout(LayoutKind.Sequential)]struct Rect{public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)]struct Message{public IntPtr Window;public uint Id;public IntPtr WParam,LParam;public uint Time;public int X,Y;public uint Private;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr GetModuleHandleW(string? name);
 [DllImport("comctl32.dll")]static extern bool InitCommonControlsEx(ref InitControls value);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern ushort RegisterClassExW(ref WindowClass wc);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool UnregisterClassW(string name,IntPtr instance);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateWindowExW(uint ex,string cls,string text,uint style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
 [DllImport("user32.dll")]static extern uint GetDpiForSystem();
 [DllImport("user32.dll")]static extern IntPtr LoadCursorW(IntPtr instance,IntPtr name);
 [DllImport("user32.dll")]static extern bool ShowScrollBar(IntPtr h,int bar,bool show);
 [DllImport("user32.dll")]static extern uint GetSysColor(int index);
 [DllImport("user32.dll")]static extern IntPtr GetSysColorBrush(int index);
 [DllImport("gdi32.dll")]static extern uint SetBkColor(IntPtr dc,uint color);
 [DllImport("gdi32.dll")]static extern uint SetTextColor(IntPtr dc,uint color);
 [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll")]static extern bool EnableWindow(IntPtr h,bool value);
 [DllImport("user32.dll")]static extern int GetWindowLongW(IntPtr h,int index);
 [DllImport("user32.dll")]static extern int SetWindowLongW(IntPtr h,int index,int value);
 [DllImport("user32.dll")]static extern IntPtr SetFocus(IntPtr h);
 [DllImport("user32.dll")]static extern bool MoveWindow(IntPtr h,int x,int y,int w,int height,bool repaint);
 [DllImport("user32.dll")]static extern bool GetClientRect(IntPtr h,out Rect value);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool SetWindowTextW(IntPtr h,string text);
 [DllImport("user32.dll")]static extern IntPtr SendMessageW(IntPtr h,uint message,IntPtr wp,IntPtr lp);
 [DllImport("user32.dll")]static extern bool PostMessageW(IntPtr h,uint message,IntPtr wp,IntPtr lp);
 [DllImport("user32.dll")]static extern int GetMessageW(out Message message,IntPtr h,uint min,uint max);
 [DllImport("user32.dll")]static extern bool IsDialogMessageW(IntPtr h,ref Message message);
 [DllImport("user32.dll")]static extern bool TranslateMessage(ref Message message);
 [DllImport("user32.dll")]static extern IntPtr DispatchMessageW(ref Message message);
 [DllImport("user32.dll")]static extern IntPtr DefWindowProcW(IntPtr h,uint message,IntPtr wp,IntPtr lp);
 [DllImport("user32.dll")]static extern bool DestroyWindow(IntPtr h);
 [DllImport("user32.dll")]static extern void PostQuitMessage(int code);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)]static extern IntPtr CreateFontW(int height,int width,int escapement,int orientation,int weight,uint italic,uint underline,uint strike,uint charset,uint output,uint clip,uint quality,uint pitch,string face);
 [DllImport("gdi32.dll")]static extern IntPtr GetStockObject(int value);
 [DllImport("gdi32.dll")]static extern bool DeleteObject(IntPtr h);
}
