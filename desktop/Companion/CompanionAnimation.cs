using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Image = System.Windows.Controls.Image;

namespace CodexLight.Desktop;

// Both atlases have the same sixteen registered key poses. Timings are asymmetric:
// the hand pauses at the mouth, while the resting blink is deliberately short.
internal sealed class CompanionAnimation {
 readonly Image front, previous;
 readonly ScaleTransform scale = new();
 readonly RotateTransform tilt = new();
 readonly TranslateTransform offset = new();
 readonly BitmapSource[] frames = new BitmapSource[16];
 readonly bool lulu;
 int frame = -1;
 CompanionPose? playing;
 double started,changed;

 internal CompanionAnimation(bool lulu,FrameworkElement stage,Image front,Image previous) {
  this.lulu=lulu;this.front=front;this.previous=previous;
  string name=lulu?"lulu":"nailong";
  using var stream=typeof(CompanionAnimation).Assembly.GetManifestResourceStream($"CodeCang.Companion.{name}.png")
   ?? throw new InvalidDataException($"桌面伙伴画面缺失：{name}");
  var atlas=new PngBitmapDecoder(stream,BitmapCreateOptions.PreservePixelFormat,BitmapCacheOption.OnLoad).Frames[0];
  int size=atlas.PixelWidth/4;
  if (size<1 || atlas.PixelHeight!=size*4 || atlas.PixelWidth!=size*4) throw new InvalidDataException("桌面伙伴动作图集尺寸无效");
  for (int i=0;i<frames.Length;i++) {
   var crop=new CroppedBitmap(atlas,new Int32Rect((i%4)*size,(i/4)*size,size,size));
   crop.Freeze();frames[i]=crop;
  }
  stage.RenderTransform=new TransformGroup { Children={scale,tilt,offset} };
  front.Source=null;previous.Source=null;
 }

 int FrameAt(CompanionPose pose,double t) => pose switch {
  CompanionPose.Idle => lulu ? (t%5.4>5.08 ? 1 : 0) : (t%6.8>4.75 ? 1 : 0),
  CompanionPose.Work when lulu => (t%2.55) switch { <.58=>2, <1.04=>3, <1.45=>4, _=>5 },
  CompanionPose.Work => t%.72<.36 ? 2 : 3,
  CompanionPose.Read => t%3<1.2 ? 4 : 5,
  CompanionPose.Question => t%3.7<2.45 ? 6 : 7,
  CompanionPose.Approval => t%3.8<2.95 ? 8 : 9,
  CompanionPose.Low => t%4.6<2.5 ? 10 : 11,
  CompanionPose.Cheer => t%1.9<.62 ? 12 : 13,
  CompanionPose.Greet => t%.52<.26 ? 14 : 15,
  _ => 0
 };

 internal void Draw(CompanionPose pose,double now,bool still) {
  bool entering=playing!=pose;
  if (entering) {playing=pose;started=now;}
  double time=still?0:Math.Max(0,now-started);
  int next=FrameAt(pose,time);
  if (frame!=next) {
   previous.Source=still||entering?null:front.Source;
   front.Source=frames[next];frame=next;changed=now;
  }
  // Keep the grounded silhouette opaque throughout a gesture. Unrelated poses cut cleanly.
  double fade=still?0:Math.Max(0,1-(now-changed)/.10);
  previous.Opacity=fade;
  if (fade<=0) previous.Source=null;
  double breath=Math.Sin(time*1.7);
  scale.ScaleX=1-.005*breath;scale.ScaleY=1+.007*breath;
  tilt.Angle=pose switch {
   CompanionPose.Work when lulu => -.9*Math.Sin(time*4),
   CompanionPose.Question => 1.2*Math.Sin(time*2),
   CompanionPose.Greet => 2.4*Math.Sin(time*11),
   _ => .45*breath
  };
  offset.Y=pose switch {
   CompanionPose.Cheer => -5*Math.Pow(Math.Max(0,Math.Sin(time*Math.Tau/1.9)),2),
   CompanionPose.Greet => -2.5*Math.Abs(Math.Sin(time*6)),
   _ => 0
  };
 }
}
