using System.Runtime.InteropServices;
internal static class Capture {
 [StructLayout(LayoutKind.Sequential)]struct Rect{public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)]struct BitmapInfo{public uint Size;public int Width,Height;public ushort Planes,Bits;public uint Compression,ImageSize;public int X,Y;public uint Used,Important;}
 internal static void Save(IntPtr hwnd,string path){
  GetWindowRect(hwnd,out var r);int w=r.Right-r.Left,h=r.Bottom-r.Top;var dc=GetWindowDC(hwnd);var mem=CreateCompatibleDC(dc);var bitmap=CreateCompatibleBitmap(dc,w,h);var old=SelectObject(mem,bitmap);
  try{SendMessageW(hwnd,0x317,mem,(IntPtr)30);SelectObject(mem,old);var info=new BitmapInfo{Size=40,Width=w,Height=-h,Planes=1,Bits=32,ImageSize=(uint)(w*h*4)};var pixels=new byte[w*h*4];if(GetDIBits(mem,bitmap,0,(uint)h,pixels,ref info,0)==0)throw new Exception("GetDIBits failed");using var writer=new BinaryWriter(File.Create(path));writer.Write((ushort)0x4d42);writer.Write(54+pixels.Length);writer.Write(0);writer.Write(54);writer.Write(40);writer.Write(w);writer.Write(-h);writer.Write((ushort)1);writer.Write((ushort)32);writer.Write(0);writer.Write(pixels.Length);for(int i=0;i<4;i++)writer.Write(0);writer.Write(pixels);
  }finally{SelectObject(mem,old);DeleteObject(bitmap);DeleteDC(mem);ReleaseDC(hwnd,dc);}
 }
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")]static extern IntPtr GetWindowDC(IntPtr h);
 [DllImport("user32.dll")]static extern int ReleaseDC(IntPtr h,IntPtr dc);
 [DllImport("user32.dll")]static extern IntPtr SendMessageW(IntPtr h,uint message,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("gdi32.dll")]static extern IntPtr CreateCompatibleDC(IntPtr h);
 [DllImport("gdi32.dll")]static extern IntPtr CreateCompatibleBitmap(IntPtr h,int w,int height);
 [DllImport("gdi32.dll")]static extern IntPtr SelectObject(IntPtr h,IntPtr obj);
 [DllImport("gdi32.dll")]static extern bool DeleteObject(IntPtr h);
 [DllImport("gdi32.dll")]static extern bool DeleteDC(IntPtr h);
 [DllImport("gdi32.dll")]static extern int GetDIBits(IntPtr dc,IntPtr bmp,uint start,uint count,byte[] bits,ref BitmapInfo info,uint usage);
}
