using CodexLight.Desktop;
using System.Diagnostics;
int count=0;void Check(bool good){if(!good)throw new Exception("Failed check");count++;}void Reject(Action action){try{action();}catch{count++;return;}throw new Exception("Unsafe input accepted");}
Check(LocalPathLinks.Normalize(@"C:\Users\Someone\space name\文件.md")==@"C:\Users\Someone\space name\文件.md");
Check(LocalPathLinks.Normalize("file:///C:/Users/space%20name/file.txt")==@"C:\Users\space name\file.txt");
foreach(var distro in new string?[]{null,"Ubuntu"})Check(LocalPathLinks.Normalize("/C:/Users/中文 目录",distro)==@"C:\Users\中文 目录");
foreach(var p in new[]{@"\\server\share\x",@"\\?\C:\x",@"C:relative",@"C:\x:ads",@"C:\a\..\x",@"C:\a\CON.txt",@"C:\name.\x","file://server/share/x","javascript:alert(1)","https://example.com", "file:///C:/x%0a.txt", "file:///C:/x?foo", "file:///C:/x#bar", "shell:AppsFolder", "C:\\x\" /evil"})Reject(()=>LocalPathLinks.Normalize(p));
var own=new Uri("http://127.0.0.1:12345");Check(LocalPathLinks.TrustedSource("http://127.0.0.1:12345/#token=example",own));
foreach(var u in new[]{"http://192.168.1.2:12345/","http://127.0.0.1:54321/","https://127.0.0.1:12345/","http://user@127.0.0.1:12345/","http://127.0.0.1:12345/other","http://localhost:12345/"})Check(!LocalPathLinks.TrustedSource(u,own));
Check(LocalPathLinks.ReadMessage("{\"type\":\"revealLocalPath\",\"path\":\"C:/file.txt\"}")=="C:/file.txt");
Reject(()=>LocalPathLinks.ReadMessage("{\"type\":\"revealLocalPath\",\"path\":\"C:/x\",\"extra\":true}"));
var plan=LocalPathLinks.Explorer(@"C:\space name\x.cmd",false);Check(!plan.UseShellExecute&&plan.ArgumentList.Count==1&&plan.ArgumentList[0]==@"/select,C:\space name\x.cmd");
foreach(var ext in new[]{".PDF",".docx",".xlsx",".odt",".epub",".zip",".mp3",".mp4"}){var f=@"C:\中文 空格\sample"+ext;var open=LocalPathLinks.OpenPlan(f,false);Check(open.UseShellExecute&&open.Verb=="open"&&open.FileName==f);}
foreach(var ext in new[]{".cmd",".bat",".exe",".lnk",".ps1",".js",".html",".url",".unknown",".pdf.exe"}){var f=@"C:\sample"+ext;var safe=LocalPathLinks.OpenPlan(f,false);Check(!safe.UseShellExecute&&safe.ArgumentList.Single()=="/select,"+f);}
var folderPlan=LocalPathLinks.OpenPlan(@"C:\folder.pdf",true);Check(!folderPlan.UseShellExecute&&folderPlan.ArgumentList.Single()==@"C:\folder.pdf");
var fixture=Path.Combine(Path.GetTempPath(),"local-links-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(fixture);var file=Path.Combine(fixture,"space 文件.txt");File.WriteAllText(file,"fixture");Check(LocalPathLinks.ValidateExisting(file)==false);Check(LocalPathLinks.ValidateExisting(fixture));Reject(()=>LocalPathLinks.ValidateExisting(Path.Combine(fixture,"missing")));
Console.WriteLine($"PASS {count} local path/link policy tests; fixture only, no Explorer/app launched.");

Check(LocalPathLinks.Normalize("/home/lee/space name/A.png","Ubuntu")==@"\\wsl.localhost\Ubuntu\home\lee\space name\A.png");
Check(LocalPathLinks.Normalize(@"\\wsl$\Ubuntu\home\lee\A.png","Ubuntu")==@"\\wsl.localhost\Ubuntu\home\lee\A.png");
foreach(var p in new[]{@"\\wsl.localhost\Debian\home\a",@"\\server\share\a","/home/../etc/a","/home/./a","/home/a:ads",@"\\wsl.localhost\Ubuntu\..\Debian\x"})Reject(()=>LocalPathLinks.Normalize(p,"Ubuntu"));
Reject(()=>LocalPathLinks.Normalize(@"\\wsl.localhost\Ubuntu\home\a"));
Check(LocalPathLinks.Normalize("/home/lee/A.png","Ubuntu")!=LocalPathLinks.Normalize("/home/lee/a.png","Ubuntu"));
Console.WriteLine($"PASS {count} including selected-distribution WSL policy tests.");

string markerExe=Path.Combine(fixture,"带空格 marker.exe"),marker=Path.Combine(fixture,"ran.txt");
var markerSource=Path.Combine(fixture,"marker.cs");
File.WriteAllText(markerSource,"class Marker { static void Main(string[] args) { System.IO.File.WriteAllText(System.IO.Path.Combine(System.AppDomain.CurrentDomain.BaseDirectory,\"ran.txt\"),args.Length.ToString()); } }");
var compiler=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"Microsoft.NET","Framework64","v4.0.30319","csc.exe");
var compile=new ProcessStartInfo(compiler){UseShellExecute=false,CreateNoWindow=true};
foreach(var arg in new[]{"/nologo","/target:winexe","/out:"+markerExe,markerSource})compile.ArgumentList.Add(arg);
using(var compiling=Process.Start(compile)!){Check(compiling.WaitForExit(15000)&&compiling.ExitCode==0);}
Check(LocalPathLinks.ExecutablePlan(markerExe,ExecutableChoice.Cancel)==null&&!File.Exists(marker));
var reveal=LocalPathLinks.ExecutablePlan(markerExe,ExecutableChoice.Reveal)!;
Check(!reveal.UseShellExecute&&Path.GetFileName(reveal.FileName)=="explorer.exe"&&reveal.ArgumentList.Single()=="/select,"+markerExe&&!File.Exists(marker));
var launch=LocalPathLinks.ExecutablePlan(markerExe,ExecutableChoice.Run)!;
Check(launch.FileName==markerExe&&launch.Arguments==""&&launch.ArgumentList.Count==0&&launch.Verb=="open");
using(var guard=new FileStream(markerExe,FileMode.Open,FileAccess.Read,FileShare.Read))
using(var running=Process.Start(launch)!){Check(running.WaitForExit(15000)&&running.ExitCode==0);}
Check(File.ReadAllText(marker)=="0");
Reject(()=>LocalPathLinks.ExecutablePlan(file,ExecutableChoice.Run));
Reject(()=>LocalPathLinks.ExecutablePlan(Path.Combine(fixture,"missing.exe"),ExecutableChoice.Run));
var pngFile=Path.Combine(fixture,"预览.png");
var pngSource=Environment.GetEnvironmentVariable("FILE_PREVIEW_TEST_PNG");
var png=pngSource!=null?File.ReadAllBytes(pngSource):Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=");
ImagePreviewActions.ValidatePng(png);ImagePreviewActions.WritePng(pngFile,png);
using(var image=File.OpenRead(pngFile)){
 var show=ImagePreviewActions.Plan(pngFile,image,false);Check(!show.UseShellExecute&&show.ArgumentList.Single()=="/select,"+pngFile);
 var open=ImagePreviewActions.Plan(pngFile,image,true);Check(open.UseShellExecute&&open.FileName==pngFile&&open.Verb=="open"&&open.Arguments=="");
}
Reject(()=>ImagePreviewActions.Plan(markerExe,new MemoryStream(png),true));
Reject(()=>ImagePreviewActions.Plan(pngFile,new MemoryStream(new byte[32]),true));
Reject(()=>ImagePreviewActions.Plan(Path.ChangeExtension(pngFile,".svg"),new MemoryStream(png),true));
Reject(()=>ImagePreviewActions.WritePng(markerExe,png));
foreach(var f in new[]{marker,markerExe,markerSource,file,pngFile})File.Delete(f);
Directory.Delete(fixture);
Console.WriteLine($"PASS {count} including user-confirmed executable launch with no parameters.");
