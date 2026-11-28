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
 readonly Stopwatch clock = Stopwatch.StartNew();
 readonly DispatcherTimer timer = new(DispatcherPriority.Background);
 CompanionState state;
 CompanionAnimation animation;
 Point? pressedAt;
 double activityStart,greetUntil;
 bool dragged,alternateGreeting;
 internal CompanionWindow(CompanionState initial,Action<string> open) {
  this.open=open; state=initial;
  InitializeComponent();
  animation=new(initial.Character=="lulu",Art,Figure,PreviousFigure);
  SourceInitialized+=(_,_)=>HwndSource.FromHwnd(new WindowInteropHelper(this).Handle).AddHook(WindowMessage);
  IsVisibleChanged+=(_,_)=>Schedule();
  timer.Tick+=(_,_)=>Render();
  Closed+=(_,_)=>{timer.Stop();Overview.IsOpen=false;SystemEvents.DisplaySettingsChanged-=DisplayChanged;};
  SystemEvents.DisplaySettingsChanged+=DisplayChanged;
  RefreshColors();Update(initial);
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
 internal void Disconnected() => Update(state.Offline());
 internal void Update(CompanionState next) {
  bool changed=state.Character!=next.Character, theme=state.Dark!=next.Dark;
  if (changed || state.Activity!=next.Activity) {
   activityStart=clock.Elapsed.TotalSeconds;
   greetUntil=0;
  }
  state=next;
  if (changed) animation=new(next.Character=="lulu",Art,Figure,PreviousFigure);
  if (theme) RefreshColors();
  Heading.Text=state.Name;
  Activity.Text=state.Status;
  string tone=state.Activity switch {
   CompanionPose.Offline => "Muted",CompanionPose.Question or CompanionPose.Approval => "Notice",
   _ when !state.Stale && state.Limiting?.Remaining<=10 => "Notice", _ => "Accent"
  };
  StatusDot.Fill=Activity.Foreground=Ink(tone);
  Running.Text=Count(state.Running);Questions.Text=Count(state.Questions);Approvals.Text=Count(state.Approvals);
  OpenApp.Content=state.Questions>0?"查看提问":state.Approvals>0?"查看审批":"打开码舱";
  QuotaRows.Children.Clear();
  QuotaNote.Text=state.Stale?"上次读取":state.Limiting?.Remaining<=10?"额度见底":state.Limiting?.Remaining>30?"额度充足":"";
  if (state.Quota.Length==0) QuotaRows.Children.Add(new TextBlock { Text=state.Connected?"暂无额度数据":"等待重新连接",Foreground=Ink("Muted"),Margin=new Thickness(0,4,0,0) });
  foreach (var window in state.Quota) AddQuota(window);
  AutomationProperties.SetName(CharacterButton,$"{state.Name}，{state.Summary}。右击查看桌面概览");
  Render();Schedule();
  string Count(int value)=>state.Connected?value.ToString():"—";
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
  if (!IsVisible || (state.ReducedMotion && greetUntil==0)) {timer.Stop();return;}
  timer.Interval=TimeSpan.FromMilliseconds(state.ReducedMotion?200:state.Activity==CompanionPose.Idle && greetUntil==0?66:50);
  timer.Start();
 }
 void Render() {
  double now=clock.Elapsed.TotalSeconds,elapsed=now-activityStart;
  bool greeting=greetUntil>now;
  if (!greeting && greetUntil!=0) {greetUntil=0;Schedule();}
  var pose=greeting ? CompanionPose.Greet : state.Pose(state.ReducedMotion?0:elapsed);
  animation.Draw(pose,now,state.ReducedMotion);
  string text=greeting ? state.Character=="lulu" ? alternateGreeting?"嗯，在呢。":"给你留了一颗。" : alternateGreeting?"我在！":"碰个爪！" : state.Summary;
  if (Summary.Text!=text) Summary.Text=text;
 }
 void Greet(object sender,RoutedEventArgs e) {
  if (dragged) { dragged=false;return; }
  alternateGreeting=!alternateGreeting;
  greetUntil=clock.Elapsed.TotalSeconds+1.15;
  Render();Schedule();
 }
 void Press(object sender,MouseButtonEventArgs e) {pressedAt=e.GetPosition(this);dragged=false;}
 void MoveCharacter(object sender,MouseEventArgs e) {
  if (e.LeftButton!=MouseButtonState.Pressed) {pressedAt=null;return;}
  if (pressedAt is not {} start) return;
  var current=e.GetPosition(this);
  if (Math.Abs(current.X-start.X)<SystemParameters.MinimumHorizontalDragDistance && Math.Abs(current.Y-start.Y)<SystemParameters.MinimumVerticalDragDistance) return;
  pressedAt=null;dragged=true;CharacterButton.ReleaseMouseCapture();
  if (Mouse.LeftButton==MouseButtonState.Pressed) DragMove();
  MoveInto(Screen.FromHandle(new WindowInteropHelper(this).Handle).WorkingArea,Position);
 }
 void RightClick(object sender,MouseButtonEventArgs e) {e.Handled=true;Overview.IsOpen=true;}
 void ShowContext(object sender,ContextMenuEventArgs e) {e.Handled=true;Overview.IsOpen=true;}
 void CharacterKey(object sender,KeyEventArgs e) {
  if (e.Key==Key.Apps || e.Key==Key.F10 && Keyboard.Modifiers==ModifierKeys.Shift) {e.Handled=true;Overview.IsOpen=true;}
 }
 void PanelKey(object sender,KeyEventArgs e) {if(e.Key==Key.Escape){e.Handled=true;Overview.IsOpen=false;CharacterButton.Focus();}}
 void OverviewOpened(object sender,EventArgs e) => OpenApp.Focus();
 void OverviewClosed(object sender,EventArgs e) {pressedAt=null;}
 void OpenMain(object sender,RoutedEventArgs e) {Overview.IsOpen=false;open(state.Questions>0?"question":state.Approvals>0?"approval":"main");}
 void OpenSettings(object sender,RoutedEventArgs e) {Overview.IsOpen=false;open("appearance");}
}
