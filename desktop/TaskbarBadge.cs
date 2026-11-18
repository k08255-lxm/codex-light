using System.Diagnostics;
using System.IO.Compression;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace CodexLight.Desktop;

internal sealed class TaskbarBadge : IDisposable {
 const int WmSettingChange=0x001A,WmThemeChanged=0x031A,WmDpiChanged=0x02E0;
 const uint FlashTaskbar=0x02,FlashUntilForeground=0x0C;
 internal static readonly (Color Fill,Color Ink) DefaultColors=(Color.FromArgb(242,60,52),Color.White);
 static readonly int ButtonCreated=(int)RegisterWindowMessage("TaskbarButtonCreated");
 readonly Form owner;
 (ulong Count,bool Attention) state;
 (ulong Count,int Size,Color Fill,Color Ink)? appliedOverlay;
 IntPtr button;
 bool flashing,disposed;

 internal TaskbarBadge(Form owner){
  this.owner=owner;
  owner.Activated+=OnActivated;owner.Deactivate+=OnDeactivated;owner.Resize+=OnResize;
  owner.VisibleChanged+=OnVisibilityChanged;owner.HandleDestroyed+=OnHandleDestroyed;
 }

 internal bool HandleMessage(string json,bool enabled){
  try{
   using var parsed=JsonDocument.Parse(json);var message=parsed.RootElement;
   if(message.ValueKind!=JsonValueKind.Object||!message.TryGetProperty("type",out var type)||type.ValueKind!=JsonValueKind.String||!type.ValueEquals("desktopTaskbarBadge"))return false;
   if(enabled&&!disposed&&message.EnumerateObject().Count()==3
    &&message.TryGetProperty("count",out var count)&&count.ValueKind==JsonValueKind.Number&&count.TryGetUInt64(out var value)
    &&message.TryGetProperty("attention",out var attention)&&attention.ValueKind is JsonValueKind.True or JsonValueKind.False)
    SetState(value,value!=0&&attention.GetBoolean());
   return true;
  }catch(JsonException){return false;}
 }

 internal void Clear()=>SetState(0,false);

 void SetState(ulong count,bool attention){
  state=(count,attention);RefreshOverlay();RefreshAttention();
 }

 internal void ObserveWindowMessage(in Message message){
  if(disposed)return;
  if(ButtonCreated!=0&&message.Msg==ButtonCreated){
   ResetButton();
   button=message.HWnd;
   RefreshOverlay();RefreshAttention();
  }else if(message.Msg is WmSettingChange or WmThemeChanged or WmDpiChanged){
   RefreshOverlay();
  }
 }

 void OnVisibilityChanged(object? sender,EventArgs args){
  if(owner.Visible){RefreshOverlay();RefreshAttention();}
  else{
   // WinForms Hide/Show reuses the HWND. Explorer may keep the button's
   // registration without sending TaskbarButtonCreated again on Show.
   SetFlashing(false);appliedOverlay=null;
  }
 }
 void OnHandleDestroyed(object? sender,EventArgs args)=>ResetButton();
 void OnActivated(object? sender,EventArgs args)=>SetFlashing(false);
 void OnDeactivated(object? sender,EventArgs args)=>RefreshAttention(false);
 void OnResize(object? sender,EventArgs args)=>RefreshAttention();

 void RefreshOverlay(){
  if(button==IntPtr.Zero||!owner.Visible)return;
  var (count,_)=state;
  bool highContrast=SystemInformation.HighContrast;
  var (fill,ink)=highContrast?(SystemColors.Highlight,SystemColors.HighlightText):DefaultColors;
  var overlay=(Count:count,Size:count==0?0:Math.Max(16,(int)Math.Round(16*GetDpiForWindow(button)/96d)),
   Fill:fill,Ink:ink);
  if(appliedOverlay==overlay)return;
  try{
   ApplyOverlay(button,overlay.Count,overlay.Size,overlay.Fill,overlay.Ink);
   appliedOverlay=overlay;
  }catch(Exception error) when(error is ExternalException or InvalidCastException){
   Trace.WriteLine($"Taskbar overlay unavailable: 0x{error.HResult:X8}");
  }
 }

 void RefreshAttention(bool? foreground=null){
  if(button==IntPtr.Zero)return;
  SetFlashing(state.Attention&&owner.Visible&&
   (owner.WindowState==FormWindowState.Minimized||!(foreground??(GetForegroundWindow()==button))));
 }

 void SetFlashing(bool value){
  if(flashing==value)return;
  var info=new FlashInfo{Size=(uint)Marshal.SizeOf<FlashInfo>(),Window=button,
   Flags=value?FlashTaskbar|FlashUntilForeground:0,Count=value?uint.MaxValue:0};
  FlashWindowEx(ref info);
  flashing=value;
 }

 void ResetButton(){
  SetFlashing(false);
  button=IntPtr.Zero;appliedOverlay=null;
 }

 public void Dispose(){
  if(disposed)return;
  disposed=true;
  owner.Activated-=OnActivated;owner.Deactivate-=OnDeactivated;owner.Resize-=OnResize;
  owner.VisibleChanged-=OnVisibilityChanged;owner.HandleDestroyed-=OnHandleDestroyed;
  Clear();ResetButton();
 }

 static void ApplyOverlay(IntPtr window,ulong count,int size,Color fill,Color ink){
  var instance=new ShellTaskbar();
  try{
   var taskbar=(ITaskbarList3)instance;
   taskbar.HrInit();
   // Explorer copies the icon during SetOverlayIcon.
   using var icon=count==0?null:CreateIcon(count,size,fill,ink);
   taskbar.SetOverlayIcon(window,icon?.DangerousGetHandle()??IntPtr.Zero,count==0?null:$"{count} 条未读更新或待回答问题");
  }finally{Marshal.FinalReleaseComObject(instance);}
 }

 internal static BadgeIcon CreateIcon(ulong count,int size,Color fill,Color ink){
  using var bitmap=DrawBadge(count,size,fill,ink);
  return new BadgeIcon(bitmap.GetHicon());
 }

 internal sealed class BadgeIcon : SafeHandleZeroOrMinusOneIsInvalid {
  internal BadgeIcon(IntPtr value):base(true){SetHandle(value);}
  protected override bool ReleaseHandle()=>DestroyIcon(handle);
 }

 static readonly int[] MaskSizes=[16,20,24,32];
 const int LabelsPerUnit=999,LabelsPerBlock=32,BlocksPerSize=125;

 static (int Index,string Label) Counter(ulong count){
  if(count>=1_000_000_000_000UL)return (4*LabelsPerUnit,"999B+");
  var (divisor,unit,suffix)=count switch{
   >=1_000_000_000=>(1_000_000_000UL,3,"B"),
   >=1_000_000=>(1_000_000UL,2,"M"),
   >=1_000=>(1_000UL,1,"K"),
   _=>(1UL,0,"")
  };
  var digits=(int)(count/divisor);
  return (unit*LabelsPerUnit+digits-1,digits.ToString(CultureInfo.InvariantCulture)+suffix);
 }

 internal static string CounterText(ulong count)=>Counter(count).Label;

 static byte[] ReadMask(int index,int sizeIndex){
  int block=sizeIndex*BlocksPerSize+index/LabelsPerBlock;
  int size=MaskSizes[sizeIndex],length=2*size*size;
  using var resource=typeof(TaskbarBadge).Assembly.GetManifestResourceStream("CodeCang.Taskbar.Counters")
   ??throw new InvalidDataException("Missing taskbar counter masks");
  using var reader=new BinaryReader(resource);
  resource.Position=block*sizeof(int);
  int start=reader.ReadInt32(),end=reader.ReadInt32();
  if(start<0||end<=start||end>resource.Length)throw new InvalidDataException("Invalid counter mask offset");
  resource.Position=start;
  using var chunk=new MemoryStream(reader.ReadBytes(end-start),writable:false);
  using var gzip=new GZipStream(chunk,CompressionMode.Decompress);
  var mask=new byte[length];
  for(int i=0;i<=index%LabelsPerBlock;i++)gzip.ReadExactly(mask);
  return mask;
 }

 internal static Bitmap DrawBadge(ulong count,int size,Color fill,Color ink){
  if(count==0)return new Bitmap(size,size,PixelFormat.Format32bppArgb);
  int sizeIndex=Array.FindIndex(MaskSizes,s=>s>=size);
  if(sizeIndex<0)sizeIndex=MaskSizes.Length-1;
  int nativeSize=MaskSizes[sizeIndex];
  var mask=ReadMask(Counter(count).Index,sizeIndex);
  var bitmap=new Bitmap(nativeSize,nativeSize,PixelFormat.Format32bppArgb);
  static int Blend(int bg,int fg,int coverage)=>(bg*(255-coverage)+fg*coverage+127)/255;
  try{
   for(int y=0,pos=0;y<nativeSize;y++)for(int x=0;x<nativeSize;x++){
    int glyph=mask[pos++],alpha=mask[pos++];
    if(alpha>0)bitmap.SetPixel(x,y,Color.FromArgb(alpha,Blend(fill.R,ink.R,glyph),Blend(fill.G,ink.G,glyph),Blend(fill.B,ink.B,glyph)));
   }
   if(size==nativeSize)return bitmap;
   return new Bitmap(bitmap,size,size);
  }finally{if(size!=nativeSize)bitmap.Dispose();}
 }

 [StructLayout(LayoutKind.Sequential)]
 struct FlashInfo{internal uint Size;internal IntPtr Window;internal uint Flags;internal uint Count;internal uint Timeout;}
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern uint RegisterWindowMessage(string name);
 [DllImport("user32.dll")]static extern uint GetDpiForWindow(IntPtr window);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool FlashWindowEx(ref FlashInfo info);
 [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool DestroyIcon(IntPtr icon);

 [ComImport,Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
 class ShellTaskbar{}

 [ComImport,Guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface ITaskbarList3{
  // Declare the inherited slots in native vtable order.
  void HrInit();
  void AddTab(IntPtr window);
  void DeleteTab(IntPtr window);
  void ActivateTab(IntPtr window);
  void SetActiveAlt(IntPtr window);
  void MarkFullscreenWindow(IntPtr window,[MarshalAs(UnmanagedType.Bool)]bool fullscreen);
  void SetProgressValue(IntPtr window,ulong completed,ulong total);
  void SetProgressState(IntPtr window,uint flags);
  void RegisterTab(IntPtr tab,IntPtr owner);
  void UnregisterTab(IntPtr tab);
  void SetTabOrder(IntPtr tab,IntPtr before);
  void SetTabActive(IntPtr tab,IntPtr owner,uint reserved);
  void ThumbBarAddButtons(IntPtr window,uint count,IntPtr buttons);
  void ThumbBarUpdateButtons(IntPtr window,uint count,IntPtr buttons);
  void ThumbBarSetImageList(IntPtr window,IntPtr images);
  void SetOverlayIcon(IntPtr window,IntPtr icon,[MarshalAs(UnmanagedType.LPWStr)]string? description);
 }
}
