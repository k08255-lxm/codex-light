using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
namespace CodexLight.Desktop;
internal enum StartupPhase { Environment, Backend, Renderer, Interface }
// This is stage feedback, never elapsed-time or percentage-based progress.
internal sealed class StartupView : Control {
 readonly System.Windows.Forms.Timer animation=new(){Interval=33};
 readonly Stopwatch clock=new();readonly Font brandFont=new("Segoe UI",14,FontStyle.Bold,GraphicsUnit.Pixel),titleFont=new("Microsoft YaHei UI",26,FontStyle.Bold,GraphicsUnit.Pixel),bodyFont=new("Microsoft YaHei UI",13,FontStyle.Regular,GraphicsUnit.Pixel),smallFont=new("Microsoft YaHei UI",11,FontStyle.Regular,GraphicsUnit.Pixel);
 readonly TextBox failureDetails=new(){ReadOnly=true,Multiline=true,ScrollBars=ScrollBars.Vertical,BorderStyle=BorderStyle.None,Visible=false,AccessibleName="启动错误详情，可选择并复制",TabStop=true};
 readonly Func<bool> animationPreference;
 static readonly string[] Steps={"运行环境","本地后台","渲染引擎","工作台界面"};
 Form? owner;
 StartupPhase phase;string detail="检测本机运行环境";bool failure,animationsAllowed,disposed;
 internal StartupPhase Phase=>phase;internal bool HasFailed=>failure;internal bool AnimationRunning=>animation.Enabled;
 internal StartupView(Func<bool>? animationPreference=null){
  this.animationPreference=animationPreference??SystemAnimationAllowed;
  SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw,true);
  Dock=DockStyle.Fill;BackColor=Color.FromArgb(24,24,24);ForeColor=Color.FromArgb(236,236,236);AccessibleRole=AccessibleRole.Pane;TabStop=false;
  Controls.Add(failureDetails);UpdateAccessibility();animation.Tick+=(_,_)=>Invalidate(ContentBounds());
 }
 internal void SetProgress(StartupPhase next,string message){if(failure)return;phase=next;detail=message;UpdateAccessibility();Invalidate(ContentBounds());}
 internal void ShowFailure(string message){failure=true;detail=message;animation.Stop();failureDetails.Text=message;failureDetails.Visible=true;UpdateAccessibility();LayoutDetails();Invalidate();}
 void UpdateAccessibility(){AccessibleName=failure?"Codex Light 启动未完成":"Codex Light 正在启动";AccessibleDescription=Steps[(int)phase]+"。"+detail;if(IsHandleCreated)AccessibilityNotifyClients(AccessibleEvents.DescriptionChange,-1);}
 static bool SystemAnimationAllowed()=>SystemParametersInfo(0x1042,0,out bool enabled,0)&&enabled;
 internal static bool ShouldAnimate(bool handle,bool visible,bool failure,bool allowed)=>handle&&visible&&!failure&&allowed;
 void RefreshAnimation(){if(disposed)return;animationsAllowed=animationPreference();bool run=ShouldAnimate(IsHandleCreated,Visible&&owner?.WindowState!=FormWindowState.Minimized,failure,animationsAllowed);if(run&&!animation.Enabled){clock.Restart();animation.Start();}else if(!run){animation.Stop();}Invalidate();}
 void OwnerResized(object? sender,EventArgs e)=>RefreshAnimation();
 protected override void OnParentChanged(EventArgs e){if(owner!=null)owner.Resize-=OwnerResized;base.OnParentChanged(e);owner=FindForm();if(owner!=null)owner.Resize+=OwnerResized;RefreshAnimation();}
 protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);RefreshAnimation();}
 protected override void OnVisibleChanged(EventArgs e){base.OnVisibleChanged(e);RefreshAnimation();}
 protected override void OnResize(EventArgs e){base.OnResize(e);LayoutDetails();}
 protected override void OnBackColorChanged(EventArgs e){base.OnBackColorChanged(e);LayoutDetails();Invalidate();}
 protected override void OnForeColorChanged(EventArgs e){base.OnForeColorChanged(e);LayoutDetails();Invalidate();}
 protected override void WndProc(ref Message m){base.WndProc(ref m);if(m.Msg is 0x001A or 0x031A)RefreshAnimation();}
 float DpiScale=>DeviceDpi/96f;
 RectangleF ContentLayout(Size size,float scale){float w=size.Width/scale,h=size.Height/scale,width=Math.Min(520,w-48);return new RectangleF((w-width)/2,Math.Max(24,(h-410)/2-12),width,410);}
 Rectangle ContentBounds(){var r=ContentLayout(ClientSize,DpiScale);return Rectangle.Ceiling(new RectangleF(r.X*DpiScale,(r.Y-12)*DpiScale,r.Width*DpiScale,(r.Height+24)*DpiScale));}
 void LayoutDetails(){if(failureDetails==null)return;var r=ContentLayout(ClientSize,DpiScale);failureDetails.Bounds=Rectangle.Round(new RectangleF(r.X*DpiScale,(r.Y+206)*DpiScale,r.Width*DpiScale,180*DpiScale));failureDetails.BackColor=SystemInformation.HighContrast?SystemColors.Window:BackColor;failureDetails.ForeColor=SystemInformation.HighContrast?SystemColors.WindowText:ForeColor;}
 protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);double age=clock.Elapsed.TotalMilliseconds;Render(e.Graphics,ClientSize,DpiScale,animationsAllowed&&!failure?Math.Clamp(age/240,0,1):1,(float)(age*.12%360));}
 internal void Render(Graphics graphics,Size size,float scale,double entrance,float angle){
  var state=graphics.Save();graphics.SmoothingMode=SmoothingMode.AntiAlias;graphics.TextRenderingHint=System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;graphics.ScaleTransform(scale,scale);
  bool hc=SystemInformation.HighContrast;Color bg=hc?SystemColors.Window:BackColor,ink=hc?SystemColors.WindowText:ForeColor;
  graphics.Clear(bg);var r=ContentLayout(size,scale);float ease=(float)(1-Math.Pow(1-entrance,3));graphics.TranslateTransform(0,8*(1-ease));
  Color Fade(Color value)=>Blend(bg,value,ease);Color muted=Fade(Blend(bg,ink,.65f)),dim=Fade(Blend(bg,ink,.38f)),main=Fade(ink),line=Fade(Blend(bg,ink,.12f)),accent=Fade(hc?ink:Color.FromArgb(242,178,92));
  using(var pen=new Pen(main,2.1f){StartCap=LineCap.Round,EndCap=LineCap.Round})graphics.DrawArc(pen,r.X,r.Y+3,20,20,42,276);
  using(var dot=new SolidBrush(accent))graphics.FillEllipse(dot,r.X+18,r.Y+11,4,4);
  Draw(graphics,"Codex Light",brandFont,main,new RectangleF(r.X+34,r.Y,r.Width-34,30));
  Draw(graphics,failure?"暂时无法打开工作台":"正在打开你的工作台",titleFont,main,new RectangleF(r.X,r.Y+52,r.Width,44));
  Draw(graphics,failure?"启动已停止。请根据下面的详情检查后重新打开。":"准备本地环境，然后载入界面。",bodyFont,muted,new RectangleF(r.X,r.Y+102,r.Width,44));
  if(failure){
   Draw(graphics,"停在「"+Steps[(int)phase]+"」",bodyFont,accent,new RectangleF(r.X,r.Y+162,r.Width,30));
   // The live view overlays a selectable, scrollable native textbox here.
   Draw(graphics,detail,bodyFont,main,new RectangleF(r.X,r.Y+206,r.Width,180));
  }else{
   for(int i=0;i<Steps.Length;i++){
    float y=r.Y+164+i*46;bool done=i<(int)phase,current=i==(int)phase;Color color=current?main:done?muted:dim;
    if(current){using var track=new Pen(line,2);graphics.DrawEllipse(track,r.X+2,y+4,14,14);using var arc=new Pen(accent,2){StartCap=LineCap.Round,EndCap=LineCap.Round};graphics.DrawArc(arc,r.X+2,y+4,14,14,angle,95);}
    else if(done){using var check=new Pen(muted,1.6f){StartCap=LineCap.Round,EndCap=LineCap.Round};graphics.DrawLines(check,new[]{new PointF(r.X+3,y+11),new PointF(r.X+7,y+15),new PointF(r.X+15,y+6)});}
    else{using var dot=new SolidBrush(dim);graphics.FillEllipse(dot,r.X+7,y+9,4,4);}
    Draw(graphics,Steps[i],bodyFont,color,new RectangleF(r.X+32,y,r.Width-100,28));
    Draw(graphics,done?"就绪":current?"进行中":"",smallFont,current?accent:muted,new RectangleF(r.Right-58,y+2,58,26));
    if(i<Steps.Length-1){using var rule=new Pen(line);graphics.DrawLine(rule,r.X+32,y+36,r.Right,y+36);}
   }
   Draw(graphics,detail,smallFont,muted,new RectangleF(r.X+32,r.Y+358,r.Width-32,50));
  }
  graphics.Restore(state);
 }
 static void Draw(Graphics graphics,string text,Font font,Color color,RectangleF rect){using var brush=new SolidBrush(color);using var format=new StringFormat{Trimming=StringTrimming.EllipsisWord};graphics.DrawString(text,font,brush,rect,format);}
 static Color Blend(Color a,Color b,float ratio)=>Color.FromArgb((int)(a.R+(b.R-a.R)*ratio),(int)(a.G+(b.G-a.G)*ratio),(int)(a.B+(b.B-a.B)*ratio));
 protected override void Dispose(bool disposing){if(disposing){disposed=true;if(owner!=null)owner.Resize-=OwnerResized;animation.Dispose();brandFont.Dispose();titleFont.Dispose();bodyFont.Dispose();smallFont.Dispose();}base.Dispose(disposing);}
 [DllImport("user32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool SystemParametersInfo(uint action,uint parameter,[MarshalAs(UnmanagedType.Bool)]out bool value,uint flags);
}
