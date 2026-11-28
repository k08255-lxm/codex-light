using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Win32;
using Border = System.Windows.Controls.Border;
using Brush = System.Windows.Media.Brush;
using KeyEventArgs = System.Windows.Input.KeyEventArgs;
using MouseEventArgs = System.Windows.Input.MouseEventArgs;
using Point = System.Windows.Point;

namespace CodexLight.Desktop;

internal partial class CompanionWindow : Window {
 readonly Action<string> open;
 readonly Func<int,bool> requestSize;
 readonly Stopwatch clock = Stopwatch.StartNew();
 readonly DispatcherTimer timer = new(DispatcherPriority.Background);
 CompanionState state;
 CompanionAnimation animation;
 Point? pressedAt;
 double waveAt,greetUntil,cheerUntil;
 bool dragged,openOnRelease,alternateGreeting;
 int? pendingSize;
 internal CompanionWindow(CompanionState initial,Action<string> open,Func<int,bool> requestSize) {
  this.open=open;this.requestSize=requestSize;state=initial;
  InitializeComponent();
  animation=new(initial.Character,Art,Figure);
  SourceInitialized+=(_,_)=>HwndSource.FromHwnd(new WindowInteropHelper(this).Handle).AddHook(WindowMessage);
  IsVisibleChanged+=(_,_)=>Schedule();
  timer.Tick+=(_,_)=>Render();
  Closed+=(_,_)=>{timer.Stop();Overview.IsOpen=false;SystemEvents.DisplaySettingsChanged-=DisplayChanged;};
  SystemEvents.DisplaySettingsChanged+=DisplayChanged;
  ApplySize(initial.SizePercent);RefreshColors();Update(initial);
 }
 static nint WindowMessage(nint hwnd,int message,nint wParam,nint lParam,ref bool handled) {
  // Petting the character should leave the insertion point in the app the user was typing in.
  if (message==0x0021 && ((lParam.ToInt64()>>16)&0xffff)==0x0201) {handled=true;return 3;}
  return 0;
 }
 internal void ShowNear(Rectangle area,System.Drawing.Point? saved) {
  new WindowInteropHelper(this).EnsureHandle();
  MoveInto(area,saved);
  System.Windows.Forms.Integration.ElementHost.EnableModelessKeyboardInterop(this);
  Show();
  var current=Screen.FromHandle(new WindowInteropHelper(this).Handle).WorkingArea;
  MoveInto(current,saved);
 }
 [DllImport("user32.dll",SetLastError=true)]
 static extern bool SetWindowPos(nint hwnd,nint insertAfter,int x,int y,int width,int height,uint flags);
 void MoveInto(Rectangle area,System.Drawing.Point? point) {
  var dpi=VisualTreeHelper.GetDpi(this);
  int w=(int)Math.Ceiling(Width*dpi.DpiScaleX),h=(int)Math.Ceiling(Height*dpi.DpiScaleY);
  int x=Math.Clamp(point?.X??area.Right-w-(int)(24*dpi.DpiScaleX),area.Left,Math.Max(area.Left,area.Right-w));
  int y=Math.Clamp(point?.Y??area.Bottom-h-(int)(16*dpi.DpiScaleY),area.Top,Math.Max(area.Top,area.Bottom-h));
  SetWindowPos(new WindowInteropHelper(this).Handle,0,x,y,0,0,0x15);
 }
 internal System.Drawing.Point Position {
  get {var p=PointToScreen(new Point(0,0));return new((int)Math.Round(p.X),(int)Math.Round(p.Y));}
 }
 void DisplayChanged(object? sender,EventArgs e) => Dispatcher.BeginInvoke(()=>{
  if (IsVisible) MoveInto(Screen.FromHandle(new WindowInteropHelper(this).Handle).WorkingArea,Position);
 });
 internal void Disconnected() {
  if(pendingSize is {} size)SizeResult(size,false);
  Update(state.Offline());
 }
 internal void Update(CompanionState next) {
  bool changed=state.Character!=next.Character, theme=state.Dark!=next.Dark;
  if (changed || state.Activity!=next.Activity) greetUntil=0;
  if (changed || next.Pose!=CompanionPose.Idle || next.Stale || next.ReducedMotion || next.Limiting?.Remaining is not >30) cheerUntil=0;
  else if(next.RecoveredFrom(state)) cheerUntil=clock.Elapsed.TotalSeconds+1.1;
  if(next.SizePercent!=state.SizePercent)ApplySize(next.SizePercent);
  state=next;
  if (changed) animation=new(next.Character,Art,Figure);
  if (theme) RefreshColors();
  Heading.Text=state.Name;
  RefreshSizeControls();
  Activity.Text=state.Status;
  string tone=state.Activity switch {
   CompanionPose.Offline => "Muted",CompanionPose.Question or CompanionPose.Approval => "Notice",
   _ when !state.Stale && state.Limiting?.Remaining<=10 => "Notice", _ => "Accent"
  };
  StatusDot.Fill=Activity.Foreground=Ink(tone);
  Running.Text=Count(state.Running);Questions.Text=Count(state.Questions);Approvals.Text=Count(state.Approvals);
  Agents.Text=Count(state.Agents);
  TaskList.Visibility=state.TaskNames.Length>0?Visibility.Visible:Visibility.Collapsed;
  var titles=state.TaskNames.AsEnumerable();
  if(state.Running>state.TaskNames.Length)titles=titles.Append($"另有 {state.Running-state.TaskNames.Length} 个任务");
  TaskNames.Text=string.Join("\n",titles);
  OpenApp.Content=state.Questions>0?"查看提问":state.Approvals>0?"查看审批":"打开码舱";
  QuotaRows.Children.Clear();
  QuotaNote.Text=state.Stale?"上次读取":state.Limiting?.Remaining<=10?"额度见底":state.Limiting?.Remaining>30?"额度充足":"";
  if (state.Quota.Length==0) QuotaRows.Children.Add(new TextBlock { Text=state.Connected?"暂无额度数据":"等待重新连接",Foreground=Ink("Muted"),Margin=new Thickness(0,4,0,0) });
  foreach (var window in state.Quota) AddQuota(window);
  AutomationProperties.SetName(CharacterButton,$"{state.Name}，{state.Summary}。双击打开码舱，右击查看概览");
  Render();Schedule();
  string Count(int value)=>state.Connected?value.ToString():"—";
 }
 void ApplySize(int percent) {
  double factor=percent/100d,oldWidth=Width,oldHeight=Height;
  var topLeft=IsVisible ? Position : (System.Drawing.Point?)null;
  // Anchor at the feet, and keep the status label readable at the smallest size.
  Width=Math.Max(156,Math.Round(172*factor));
  Height=Math.Round(158*factor)+28;
  Art.Width=Math.Round(166*factor);
  FootShadow.Width=97*factor;FootShadow.Height=13*factor;
  if(topLeft is {} point){
   var dpi=VisualTreeHelper.GetDpi(this);
   var area=Screen.FromPoint(new System.Drawing.Point(point.X+(int)(oldWidth*dpi.DpiScaleX/2),point.Y+(int)(oldHeight*dpi.DpiScaleY/2))).WorkingArea;
   point.Offset((int)Math.Round((oldWidth-Width)*dpi.DpiScaleX/2),(int)Math.Round((oldHeight-Height)*dpi.DpiScaleY));
   MoveInto(area,point);
  }
 }
 void RefreshSizeControls() {
  SizeLabel.Text=$"{state.SizePercent}%";
  Smaller.IsEnabled=pendingSize==null && state.SizePercent>CompanionState.MinSize;
  Larger.IsEnabled=pendingSize==null && state.SizePercent<CompanionState.MaxSize;
 }
 void ChangeSize(object sender,RoutedEventArgs e) {
  if(pendingSize!=null)return;
  int size=state.SizePercent+(sender==Larger?CompanionState.SizeStep:-CompanionState.SizeStep);
  if(size<CompanionState.MinSize || size>CompanionState.MaxSize)return;
  pendingSize=size;SizeError.Visibility=Visibility.Collapsed;RefreshSizeControls();
  if(!requestSize(size))SizeResult(size,false);
 }
 internal void SizeResult(int size,bool saved) {
  if(pendingSize!=size)return;
  pendingSize=null;SizeError.Visibility=saved?Visibility.Collapsed:Visibility.Visible;RefreshSizeControls();
 }
 Brush Ink(string key)=>(Brush)FindResource(key);
 void RefreshColors() {
  foreach (var (key,light,dark) in new[]{
   ("Surface","#FCFBF8","#282C2B"),("Text","#252824","#F2F2E9"),("Muted","#62675F","#B4BDB7"),
   ("Line","#DFE2D9","#464C49"),("Soft","#EFF1EA","#373D39"),("Accent","#38785C","#9DCEAC"),("Notice","#995E18","#F1BD72") })
   Resources[key]=(Brush)new BrushConverter().ConvertFromString(state.Dark?dark:light)!;
 }
 void AddQuota(QuotaWindow window) {
  var row=new DockPanel { Margin=new Thickness(0,5,0,0) };
  var percentage=new TextBlock { Text=window.Percent,FontWeight=FontWeights.SemiBold };
  DockPanel.SetDock(percentage,Dock.Right);row.Children.Add(percentage);
  row.Children.Add(new TextBlock { Text=window.Label,Foreground=Ink("Muted") });
  var meter=new Grid { Height=4,Margin=new Thickness(0,3,0,2) };
  meter.Children.Add(new Border { CornerRadius=new CornerRadius(2),Background=Ink("Soft") });
  var fill=new Border { CornerRadius=new CornerRadius(2),Background=Ink(state.Stale?"Muted":window.Remaining<=10?"Notice":"Accent") };
  fill.RenderTransform=new ScaleTransform(window.Remaining/100,1);
  meter.Children.Add(fill);
  QuotaRows.Children.Add(row);QuotaRows.Children.Add(meter);
 }
 void Schedule() {
  if (!IsVisible || ((state.ReducedMotion || !state.Connected) && greetUntil==0)) {timer.Stop();return;}
  timer.Interval=TimeSpan.FromMilliseconds(state.ReducedMotion?200:1000d/30);
  timer.Start();
 }
 void Render() {
  double now=clock.Elapsed.TotalSeconds;
  bool greeting=greetUntil>now;
  if (!greeting && greetUntil!=0) {greetUntil=0;Schedule();}
  var pose=greeting ? CompanionPose.Greet : now<cheerUntil ? CompanionPose.Cheer : state.Pose;
  // A layered window is hit-tested against its painted pixels. Keep the sofa, paws
  // and badge under the pointer until Windows can distinguish a double click.
  bool holdTarget=greeting && (now<waveAt || openOnRelease);
  Art.Opacity=holdTarget ? .88 : 1;
  if(!holdTarget){StatusBadge.MinWidth=0;animation.Draw(pose,now,state.ReducedMotion);}
  string text=greeting ? state.Character=="lulu" ? alternateGreeting?"嗯，在呢。":"给你留了一颗。" : alternateGreeting?"我在！":"碰个爪！" : state.Summary;
  if (Summary.Text!=text) Summary.Text=text;
 }
 void Greet(object sender,RoutedEventArgs e) {
  if (dragged) { dragged=false;return; }
  bool pointer=pressedAt.HasValue;pressedAt=null;
  if(openOnRelease){
   openOnRelease=false;greetUntil=0;cheerUntil=0;Overview.IsOpen=false;Render();Schedule();open("main");return;
  }
  alternateGreeting=!alternateGreeting;
  waveAt=clock.Elapsed.TotalSeconds+(pointer?SystemInformation.DoubleClickTime/1000d:0);
  greetUntil=waveAt+1.15;
  if(pointer)StatusBadge.MinWidth=StatusBadge.ActualWidth;
  Render();Schedule();
 }
 void Press(object sender,MouseButtonEventArgs e) {
  pressedAt=e.GetPosition(this);dragged=false;
  openOnRelease=e.ClickCount==2;
 }
 void MoveCharacter(object sender,MouseEventArgs e) {
  if (e.LeftButton!=MouseButtonState.Pressed) {pressedAt=null;return;}
  if (pressedAt is not {} start) return;
  var current=e.GetPosition(this);
  if (Math.Abs(current.X-start.X)<SystemParameters.MinimumHorizontalDragDistance && Math.Abs(current.Y-start.Y)<SystemParameters.MinimumVerticalDragDistance) return;
  pressedAt=null;dragged=true;openOnRelease=false;CharacterButton.ReleaseMouseCapture();
  if (Mouse.LeftButton==MouseButtonState.Pressed) DragMove();
  MoveInto(Screen.FromHandle(new WindowInteropHelper(this).Handle).WorkingArea,Position);
 }
 void RightClick(object sender,MouseButtonEventArgs e) {e.Handled=true;Overview.IsOpen=true;}
 void ShowContext(object sender,ContextMenuEventArgs e) {e.Handled=true;Overview.IsOpen=true;}
 void CharacterKey(object sender,KeyEventArgs e) {
  if(e.Key is Key.Space or Key.Enter){openOnRelease=false;dragged=false;pressedAt=null;}
  if (e.Key==Key.Apps || e.Key==Key.F10 && Keyboard.Modifiers==ModifierKeys.Shift) {e.Handled=true;Overview.IsOpen=true;}
 }
 void PanelKey(object sender,KeyEventArgs e) {if(e.Key==Key.Escape){e.Handled=true;Overview.IsOpen=false;CharacterButton.Focus();}}
 void OverviewOpened(object sender,EventArgs e) => OpenApp.Focus();
 void OverviewClosed(object sender,EventArgs e) {pressedAt=null;}
 void OpenMain(object sender,RoutedEventArgs e) {Overview.IsOpen=false;open(state.Questions>0?"question":state.Approvals>0?"approval":"main");}
 void OpenSettings(object sender,RoutedEventArgs e) {Overview.IsOpen=false;open("appearance");}
}
