using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Image = System.Windows.Controls.Image;

namespace CodexLight.Desktop;

internal sealed class CompanionAnimation {
 enum Sheet { Routine, Phases, Reactions, Team }

 // Durations are in milliseconds. Holds belong to the drawing (a blink, a keypress,
 // a chew), independently of the host's paint rate.
 sealed class Clip(Sheet sheet,int first,params int[] durations) {
  public Sheet Sheet {get;}=sheet;
  readonly int total=durations.Sum();
  public int FrameAt(double seconds) {
   double ms=seconds*1000 % total;
   for(int i=0;i<durations.Length-1;i++){
    ms-=durations[i];
    if(ms<0)return first+i;
   }
   return first+durations.Length-1;
  }
 }
 static readonly Clip idle=new(Sheet.Routine,0,1100,320,850,90,60,43,65,43,55,90,600,240,900,380,900,350);
 static readonly Clip type=new(Sheet.Routine,16,100,65,70,60,70,75,80,70,80,70,85,65,80,70,110,90);
 static readonly Clip snack=new(Sheet.Routine,16,160,90,100,90,90,80,100,80,150,100,180,90,130,85,160,90);
 static readonly Clip think=new(Sheet.Phases,0,240,90,110,90,145,100,260,100,150,100,140,90,150,105,240,100);
 static readonly Clip command=new(Sheet.Phases,16,145,75,100,65,85,65,100,75,145,90,115,75,115,75,140,90);
 static readonly Clip team=new(Sheet.Team,0,160,120,100,105,120,100,150,100,160,120,100,105,120,100,150,100);
 static readonly Clip question=new(Sheet.Reactions,0,950,140,240,130,550,140,250,160);
 static readonly Clip approval=new(Sheet.Reactions,8,860,150,250,120,490,135,170,140);
 static readonly Clip low=new(Sheet.Reactions,16,1250,180,250,145,520,195,290,180);
 static readonly Clip greet=new(Sheet.Reactions,24,100,70,115,75,140,80,115,90);
 static readonly Clip cheer=new(Sheet.Reactions,32,475,725);

 readonly string character;
 readonly Image image;
 readonly ScaleTransform scale=new();
 readonly TranslateTransform offset=new();
 readonly Dictionary<Sheet,BitmapSource[]> sheets=new();
 CompanionPose? playing;
 double started;

 internal CompanionAnimation(string character,FrameworkElement stage,Image image) {
  this.character=character;this.image=image;
  stage.RenderTransform=new TransformGroup {Children={scale,offset}};
 }
 BitmapSource[] Load(Sheet sheet) {
  if(sheets.TryGetValue(sheet,out var frames))return frames;
  string suffix=sheet switch {Sheet.Routine=>"-routine",Sheet.Phases=>"-phases",Sheet.Team=>"-team",_=>""};
  using var stream=typeof(CompanionAnimation).Assembly.GetManifestResourceStream($"CodeCang.Companion.{character}{suffix}.png")
   ??throw new InvalidDataException($"缺少桌面伙伴动作图集：{character}{suffix}");
  var atlas=new PngBitmapDecoder(stream,BitmapCreateOptions.PreservePixelFormat,BitmapCacheOption.OnLoad).Frames[0];
  int size=atlas.PixelWidth/4,rows=sheet switch {Sheet.Reactions=>9,Sheet.Team=>4,_=>8};
  if(size<1 || atlas.PixelWidth!=size*4 || atlas.PixelHeight!=size*rows)throw new InvalidDataException("桌面伙伴动作图集尺寸无效");
  atlas.Freeze();
  frames=new BitmapSource[sheet==Sheet.Reactions?34:4*rows];
  for(int i=0;i<frames.Length;i++){
   var crop=new CroppedBitmap(atlas,new Int32Rect(i%4*size,i/4*size,size,size));
   crop.Freeze();frames[i]=crop;
  }
  sheets.Add(sheet,frames);
  return frames;
 }
 internal void Draw(CompanionPose pose,double now,bool still) {
  if(playing!=pose){playing=pose;started=now;}
  double t=still||pose==CompanionPose.Offline?0:Math.Max(0,now-started);
  var clip=pose switch {
   CompanionPose.Work=>character=="lulu"?snack:type, CompanionPose.Thinking=>think, CompanionPose.Command=>command, CompanionPose.Team=>team,
   CompanionPose.Question=>question, CompanionPose.Approval=>approval, CompanionPose.Low=>low,
   CompanionPose.Greet=>greet, CompanionPose.Cheer=>cheer, _=>idle
  };
  var frame=Load(clip.Sheet)[clip.FrameAt(t)];
  if(image.Source!=frame)image.Source=frame;
  // Furniture and the terminal are grounded in the art. Only the standing dragon
  // breathes during long idle holds. A quota recovery has a single little lift.
  double breath=character=="nailong" && pose==CompanionPose.Idle ? Math.Sin(t*1.35) : 0;
  scale.ScaleX=1-.002*breath;scale.ScaleY=1+.004*breath;
  offset.Y=pose==CompanionPose.Cheer && t<.48 ? -4*Math.Sin(t*Math.PI/.48) : 0;
 }
}
