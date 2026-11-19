using System.Buffers.Binary;
using System.Diagnostics;
using System.Drawing.Imaging;
using System.Text.Json;

namespace CodexLight.Desktop;

internal static class ImagePreviewActions {
 internal const int MaxBytes=16*1024*1024;
 internal static bool Handle(IWin32Window owner,string json,string? distribution){
  if(!json.Contains("\"previewImageAction\"",StringComparison.Ordinal))return false;
  if(json.Length>4*((MaxBytes+2)/3)+1024)throw new InvalidDataException("Image message too large.");
  using var message=JsonDocument.Parse(json);var body=message.RootElement;
  if(body.ValueKind!=JsonValueKind.Object||!body.TryGetProperty("type",out var type)||type.GetString()!="previewImageAction")return false;
  if(body.EnumerateObject().Count()!=3||!body.TryGetProperty("action",out var command)||command.GetString() is not ("open" or "reveal"))throw new InvalidDataException("Invalid image action.");
  bool open=command.GetString()=="open";
  string? path;
  if(body.TryGetProperty("path",out var file)){
   path=LocalPathLinks.Normalize(file.GetString()??"",distribution);
   if(LocalPathLinks.ValidateExisting(path,distribution))throw new InvalidDataException("Expected an image file.");
   using var guard=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
   var plan=Plan(path,guard,open);
   Process.Start(plan)?.Dispose();
  }else{
   if(!body.TryGetProperty("png",out var data)||data.ValueKind!=JsonValueKind.String)throw new InvalidDataException("Missing image pixels.");
   var bytes=data.GetBytesFromBase64();ValidatePng(bytes);
   using var picker=new SaveFileDialog{Title=open?"保存当前图片并用默认应用打开":"保存当前图片并在资源管理器中显示",DefaultExt="png",Filter="PNG 图片 (*.png)|*.png",AddExtension=true,OverwritePrompt=true,FileName="图片.png"};
   if(picker.ShowDialog(owner)!=DialogResult.OK)return true;
   path=LocalPathLinks.Normalize(picker.FileName);
   WritePng(path,bytes);
   if(LocalPathLinks.ValidateExisting(path))throw new InvalidDataException("Expected a saved image.");
   using var guard=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
   Process.Start(Plan(path,guard,open))?.Dispose();
  }
  return true;
 }

 internal static ProcessStartInfo Plan(string path,Stream input,bool open){
  var extension=Path.GetExtension(path).ToLowerInvariant();
  if(extension is not (".png" or ".jpg" or ".jpeg" or ".gif" or ".webp" or ".ico" or ".svg"))throw new InvalidDataException("Unsupported image extension.");
  if(!open)return LocalPathLinks.Explorer(path,false);
  Span<byte> header=stackalloc byte[12];input.ReadExactly(header);
  bool match=extension switch{
   ".png"=>header.StartsWith(new byte[]{137,80,78,71,13,10,26,10}),
   ".jpg" or ".jpeg"=>header.StartsWith(new byte[]{255,216,255}),
   ".gif"=>header.StartsWith("GIF87a"u8)||header.StartsWith("GIF89a"u8),
   ".webp"=>header.StartsWith("RIFF"u8)&&header[8..].SequenceEqual("WEBP"u8),
   ".ico"=>header.StartsWith(new byte[]{0,0,1,0}),
   _=>false
  };
  if(!match)throw new InvalidDataException("Invalid raster image.");
  return new ProcessStartInfo(path){UseShellExecute=true,Verb="open"};
 }

 internal static void ValidatePng(byte[] bytes){
  if(bytes.Length<33||bytes.Length>MaxBytes||!bytes.AsSpan(0,8).SequenceEqual(new byte[]{137,80,78,71,13,10,26,10})||!bytes.AsSpan(12,4).SequenceEqual("IHDR"u8))throw new InvalidDataException("Invalid PNG.");
  uint width=BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(16)),height=BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(20));
  if(width is 0 or >4096||height is 0 or >4096||(long)width*height>16000000)throw new InvalidDataException("PNG dimensions exceed display limits.");
 }

 internal static void WritePng(string path,byte[] bytes){
  if(!Path.GetExtension(path).Equals(".png",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Choose a PNG filename.");
  var folder=Path.GetDirectoryName(path)??throw new InvalidDataException("Missing save directory.");
  if(!LocalPathLinks.ValidateExisting(folder))throw new InvalidDataException("Invalid save directory.");
  bool overwrite=File.Exists(path);
  if(overwrite)LocalPathLinks.ValidateExisting(path);
  string temporary=Path.Combine(folder,Guid.NewGuid().ToString("N")+".tmp");
  using var stream=new MemoryStream(bytes);
  Image decoded;
  try{decoded=Image.FromStream(stream,false,true);}catch(OutOfMemoryException e){throw new InvalidDataException("Invalid PNG content.",e);}
  using var image=decoded;using var bitmap=new Bitmap(image);
  var output=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None);
  try{
   using(output)bitmap.Save(output,ImageFormat.Png);
   File.Move(temporary,path,overwrite);
  }finally{File.Delete(temporary);}
 }
}
