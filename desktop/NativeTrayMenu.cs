using System.ComponentModel;
using System.Runtime.InteropServices;
namespace CodexLight.Desktop;
// Like DSH's Electron Menu template: OS popup, two commands and a separator.
// Windows owns menu metrics, keyboard navigation, contrast and dismissal.
internal static class NativeTrayMenu {
 internal static uint Show(IntPtr owner,Point location){
  var menu=CreatePopupMenu();if(menu==IntPtr.Zero)throw new Win32Exception();
  try{
   if(!AppendMenu(menu,0,1,"打开码舱 CodeCang")||!AppendMenu(menu,0x800,0,null)||!AppendMenu(menu,0,2,"退出码舱 CodeCang"))throw new Win32Exception();
   SetForegroundWindow(owner);
   uint command=TrackPopupMenuEx(menu,0x100|0x2,location.X,location.Y,owner,IntPtr.Zero);
   // Required notification-menu dismissal pattern: return ownership to message loop.
   PostMessage(owner,0,IntPtr.Zero,IntPtr.Zero);
   return command;
  }finally{DestroyMenu(menu);}
 }
 internal static void Dispatch(uint command,Action open,Action quit){if(command==1)open();else if(command==2)quit();}
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr CreatePopupMenu();
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool AppendMenu(IntPtr menu,uint flags,nuint id,string? text);
 [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool DestroyMenu(IntPtr menu);
 [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")]static extern uint TrackPopupMenuEx(IntPtr menu,uint flags,int x,int y,IntPtr owner,IntPtr parameters);
 [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool PostMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
}
