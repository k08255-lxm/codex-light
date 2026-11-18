using System.ComponentModel;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using CodexLight.Desktop;

internal static class BadgePreview {
 static readonly ulong[] Counts=[1,8,12,99,100,1_234];
 static readonly int[] Sizes=[16,24,32];
 static readonly Color Light=Color.FromArgb(244,243,247),Dark=Color.FromArgb(34,33,38);

 internal static void Save(){
  const int panelWidth=474,panelHeight=515;
  string path=Path.GetFullPath(".tmp/taskbar-badge-preview.png");
  Directory.CreateDirectory(Path.GetDirectoryName(path)!);
  using var sheet=new Bitmap(1103,647,PixelFormat.Format24bppRgb);
  using var graphics=Graphics.FromImage(sheet);
  graphics.Clear(Color.FromArgb(250,250,252));
  graphics.TextRenderingHint=TextRenderingHint.AntiAliasGridFit;
  graphics.InterpolationMode=InterpolationMode.NearestNeighbor;
  graphics.PixelOffsetMode=PixelOffsetMode.Half;
  using var title=new Font("Microsoft YaHei UI",23,FontStyle.Bold,GraphicsUnit.Pixel);
  using var label=new Font("Microsoft YaHei UI",13,FontStyle.Regular,GraphicsUnit.Pixel);
  using var small=new Font("Segoe UI",13,FontStyle.Regular,GraphicsUnit.Pixel);
  using var ink=new SolidBrush(Color.FromArgb(31,30,36));
  using var muted=new SolidBrush(Color.FromArgb(87,84,96));
  using var centered=new StringFormat{Alignment=StringAlignment.Center};
  graphics.DrawString("Windows 任务栏角标",title,ink,24,19);
  graphics.DrawString("每组上方用原始像素演示角标叠放位置，下方将同一个 Windows 图标放大两倍。",label,muted,25,57);

  foreach(var (x,heading,background,foreground) in new[]{
   (110,"浅色任务栏底色",Light,Color.FromArgb(35,32,42)),(604,"深色任务栏底色",Dark,Color.WhiteSmoke)}){
   using var panel=new SolidBrush(background);
   using var text=new SolidBrush(foreground);
   using var divider=new Pen(Color.FromArgb(30,foreground));
   graphics.DrawString(heading,label,ink,x+1,86);
   graphics.FillRectangle(panel,x,108,panelWidth,panelHeight);
   for(int row=0;row<Sizes.Length;row++){
    int y=148+row*157;
    graphics.DrawLine(divider,x+10,y,x+panelWidth-10,y);
   }
   for(int column=0;column<Counts.Length;column++){
    ulong count=Counts[column];int center=x+41+column*78;
    graphics.DrawString(TaskbarBadge.CounterText(count),small,text,center,121,centered);
    for(int row=0;row<Sizes.Length;row++){
     int size=Sizes[row],top=154+row*157;
     using var badge=CreateIcon(count,size);
     using var app=new Icon("desktop/app.ico",size*2,size*2);
     int overlap=size/4;
     using var button=Render(size*2+overlap,background,(app.Handle,0,overlap,size*2),(badge.DangerousGetHandle(),size+overlap,0,size));
     graphics.DrawImageUnscaled(button,center-button.Width/2,top+(68-button.Height)/2);
     using var standalone=Render(badge,size,background);
     graphics.DrawImage(standalone,new Rectangle(center-size,top+113-size,size*2,size*2),0,0,size,size,GraphicsUnit.Pixel);
    }
   }
  }
  for(int row=0;row<Sizes.Length;row++){
   int size=Sizes[row],y=173+row*157;
   graphics.DrawString($"{size} px",small,ink,25,y);
   graphics.DrawString($"{size*100/16}%",small,muted,25,y+19);
  }
  sheet.Save(path,ImageFormat.Png);
  Console.WriteLine(path);
 }

 internal static void VerifyNativeIcon(int size){
  using var icon=CreateIcon(100,size);
  if(!GetIconInfo(icon.DangerousGetHandle(),out var info))throw new Win32Exception();
  try{
   var color=Describe(info.Color);
   var mask=Describe(info.Mask);
   if(color.Width!=size||color.Height!=size||color.BitsPerPixel!=32||mask.Width!=size||mask.Height!=size||mask.BitsPerPixel!=1)
    throw new InvalidOperationException("Unexpected HICON color bitmap or mask");
   var pixels=new byte[color.Stride*color.Height];
   if(GetBitmapBits(info.Color,pixels.Length,pixels)!=pixels.Length)throw new Win32Exception();
   if(!Enumerable.Range(0,size*size).Any(index=>pixels[(index/size)*color.Stride+(index%size)*4+3] is >0 and <255))
    throw new InvalidOperationException("HICON color bitmap lacks antialiased alpha pixels");
  }finally{
   if(info.Color!=IntPtr.Zero)DeleteObject(info.Color);
   if(info.Mask!=IntPtr.Zero)DeleteObject(info.Mask);
  }
  using var light=Render(icon,size,Light);
  using var dark=Render(icon,size,Dark);
  bool transparent=light.GetPixel(0,0).ToArgb()==Light.ToArgb()&&dark.GetPixel(0,0).ToArgb()==Dark.ToArgb();
  bool opaque=light.GetPixel(size/2,size/2)==dark.GetPixel(size/2,size/2);
  bool antialiased=HasBlendedEdge(light,dark);
  if(!transparent||!opaque||!antialiased)
   throw new InvalidOperationException($"HICON {size}px: transparent={transparent}, opaque={opaque}, antialiased={antialiased}");
 }

 internal static Bitmap CaptureTaskbar(){
  IntPtr tray=FindWindow("Shell_TrayWnd",null);
  if(tray==IntPtr.Zero||!GetWindowRect(tray,out var bounds))throw new Win32Exception();
  int width=bounds.Right-bounds.Left,height=bounds.Bottom-bounds.Top;
  if(height<16||height>120||width<height)throw new InvalidOperationException("The preview needs a visible horizontal taskbar");
  var screenshot=new Bitmap(width,height,PixelFormat.Format32bppArgb);
  try{
   using var graphics=Graphics.FromImage(screenshot);
   graphics.CopyFromScreen(bounds.Left,bounds.Top,0,0,screenshot.Size,CopyPixelOperation.SourceCopy);
   return screenshot;
  }catch{screenshot.Dispose();throw;}
 }

 internal static void SaveExplorer(Bitmap empty,Bitmap count,Bitmap capped){
  int height=empty.Height,width=empty.Width;
  int ChangedBy(Color first,Color second)=>Math.Abs(first.R-second.R)+Math.Abs(first.G-second.G)+Math.Abs(first.B-second.B);
  var changed=new int[width];
  for(int x=0;x<width;x++)for(int y=0;y<height;y++){
   var before=empty.GetPixel(x,y);
   if(ChangedBy(before,count.GetPixel(x,y))>36&&ChangedBy(before,capped.GetPixel(x,y))>36)changed[x]++;
  }
  int edgeWidth=Math.Max(16,height/3),strongest=0,best=0;
  for(int left=0;left<=width-edgeWidth;left++){
   int strength=0;
   for(int x=left;x<left+edgeWidth;x++)strength+=changed[x];
   if(strength>strongest){strongest=strength;best=left;}
  }
  if(strongest<16)throw new InvalidOperationException("The captured taskbar does not show a visible badge");

  string path=Path.GetFullPath(".tmp/taskbar-badge-explorer.png");
  Directory.CreateDirectory(Path.GetDirectoryName(path)!);
  int cropWidth=Math.Max(height,48),cropX=Math.Clamp(best+edgeWidth/2-cropWidth*2/3,0,width-cropWidth);
  var source=new Rectangle(cropX,0,cropWidth,height);
  using var sheet=new Bitmap(3*(cropWidth*3+26)+26,112+height*4,PixelFormat.Format24bppRgb);
  using var graphics=Graphics.FromImage(sheet);
  graphics.Clear(Color.FromArgb(250,250,252));
  graphics.InterpolationMode=InterpolationMode.NearestNeighbor;
  graphics.PixelOffsetMode=PixelOffsetMode.Half;
  graphics.TextRenderingHint=TextRenderingHint.AntiAliasGridFit;
  using var title=new Font("Microsoft YaHei UI",18,FontStyle.Bold,GraphicsUnit.Pixel);
  using var label=new Font("Microsoft YaHei UI",12,FontStyle.Regular,GraphicsUnit.Pixel);
  using var ink=new SolidBrush(Color.FromArgb(31,30,36));
  graphics.DrawString("Windows Explorer 实际任务栏截图",title,ink,24,15);
  graphics.DrawString("每列上方为原始像素，下方放大三倍。",label,ink,25,44);
  foreach(var (image,caption,column) in new[]{(empty,"无角标",0),(count,"12",1),(capped,"100",2)}){
   int x=26+column*(cropWidth*3+26);
   graphics.DrawString(caption,label,ink,x,63);
   graphics.DrawImage(image,new Rectangle(x,81,cropWidth,height),source,GraphicsUnit.Pixel);
   graphics.DrawImage(image,new Rectangle(x,90+height,cropWidth*3,height*3),source,GraphicsUnit.Pixel);
  }
  sheet.Save(path,ImageFormat.Png);
  Console.WriteLine(path);
 }

 static bool HasBlendedEdge(Bitmap light,Bitmap dark){
  for(int y=0;y<light.Height;y++)for(int x=0;x<light.Width;x++){
   var pixel=light.GetPixel(x,y);
   if(pixel.ToArgb()!=Light.ToArgb()&&pixel!=dark.GetPixel(x,y))return true;
  }
  return false;
 }

 static TaskbarBadge.BadgeIcon CreateIcon(ulong count,int size){
  var (fill,ink)=TaskbarBadge.DefaultColors;
  return TaskbarBadge.CreateIcon(count,size,fill,ink);
 }

 static Bitmap Render(TaskbarBadge.BadgeIcon icon,int size,Color background)=>Render(size,background,(icon.DangerousGetHandle(),0,0,size));

 static Bitmap Render(int size,Color background,params (IntPtr Handle,int X,int Y,int Size)[] icons){
  IntPtr hdc=CreateCompatibleDC(IntPtr.Zero);
  if(hdc==IntPtr.Zero)throw new Win32Exception();
  IntPtr dib=IntPtr.Zero,previous=IntPtr.Zero;
  try{
   var header=new DibHeader{Size=(uint)Marshal.SizeOf<DibHeader>(),Width=size,Height=-size,Planes=1,BitsPerPixel=32};
   dib=CreateDIBSection(hdc,ref header,0,out var bits,IntPtr.Zero,0);
   if(dib==IntPtr.Zero)throw new Win32Exception();
   previous=SelectObject(hdc,dib);
   if(previous==IntPtr.Zero)throw new Win32Exception();
   int[] pixels=Enumerable.Repeat(background.ToArgb(),size*size).ToArray();
   Marshal.Copy(pixels,0,bits,pixels.Length);
   foreach(var (handle,x,y,width) in icons)
    if(!DrawIconEx(hdc,x,y,handle,width,width,0,IntPtr.Zero,3))throw new Win32Exception();
   GdiFlush();
   using var view=new Bitmap(size,size,size*4,PixelFormat.Format32bppRgb,bits);
   return new Bitmap(view);
  }finally{
   if(previous!=IntPtr.Zero)SelectObject(hdc,previous);
   if(dib!=IntPtr.Zero)DeleteObject(dib);
   DeleteDC(hdc);
  }
 }

 static NativeBitmap Describe(IntPtr bitmap){
  if(GetObject(bitmap,Marshal.SizeOf<NativeBitmap>(),out var result)==0)throw new Win32Exception();
  return result;
 }

 [StructLayout(LayoutKind.Sequential)]struct IconInfo{internal int IsIcon,X,Y;internal IntPtr Mask,Color;}
 [StructLayout(LayoutKind.Sequential)]struct NativeBitmap{internal int Type,Width,Height,Stride;internal ushort Planes,BitsPerPixel;internal IntPtr Bits;}
 [StructLayout(LayoutKind.Sequential)]struct DibHeader{internal uint Size;internal int Width,Height;internal ushort Planes,BitsPerPixel;internal uint Compression,ImageSize;internal int XPelsPerMeter,YPelsPerMeter;internal uint ClrUsed,ClrImportant;}
 [StructLayout(LayoutKind.Sequential)]struct NativeRect{internal int Left,Top,Right,Bottom;}
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr FindWindow(string className,string? title);
 [DllImport("user32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool GetWindowRect(IntPtr window,out NativeRect rectangle);
 [DllImport("user32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool GetIconInfo(IntPtr icon,out IconInfo info);
 [DllImport("user32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool DrawIconEx(IntPtr hdc,int x,int y,IntPtr icon,int width,int height,uint step,IntPtr brush,uint flags);
 [DllImport("gdi32.dll",SetLastError=true,EntryPoint="GetObjectW")]static extern int GetObject(IntPtr bitmap,int size,out NativeBitmap result);
 [DllImport("gdi32.dll",SetLastError=true)]static extern int GetBitmapBits(IntPtr bitmap,int size,[Out]byte[] result);
 [DllImport("gdi32.dll",SetLastError=true)]static extern IntPtr CreateCompatibleDC(IntPtr hdc);
 [DllImport("gdi32.dll",SetLastError=true)]static extern IntPtr CreateDIBSection(IntPtr hdc,ref DibHeader header,uint usage,out IntPtr bits,IntPtr section,uint offset);
 [DllImport("gdi32.dll",SetLastError=true)]static extern IntPtr SelectObject(IntPtr hdc,IntPtr item);
 [DllImport("gdi32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool GdiFlush();
 [DllImport("gdi32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool DeleteDC(IntPtr hdc);
 [DllImport("gdi32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool DeleteObject(IntPtr bitmap);
}
