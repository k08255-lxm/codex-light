using CodexLight.Desktop;
int count=0;void Check(bool good){if(!good)throw new Exception("Failed check");count++;}void Reject(Action action){try{action();}catch{count++;return;}throw new Exception("Unsafe input accepted");}
Check(LocalPathLinks.Normalize(@"C:\Users\Someone\space name\文件.md")==@"C:\Users\Someone\space name\文件.md");
Check(LocalPathLinks.Normalize("file:///C:/Users/space%20name/file.txt")==@"C:\Users\space name\file.txt");
foreach(var p in new[]{@"\\server\share\x",@"\\?\C:\x",@"C:relative",@"C:\x:ads",@"C:\a\..\x",@"C:\a\CON.txt",@"C:\name.\x","file://server/share/x","javascript:alert(1)","https://example.com", "file:///C:/x%0a.txt", "file:///C:/x?foo", "file:///C:/x#bar", "shell:AppsFolder", "C:\\x\" /evil"})Reject(()=>LocalPathLinks.Normalize(p));
var own=new Uri("http://127.0.0.1:12345");Check(LocalPathLinks.TrustedSource("http://127.0.0.1:12345/#token=example",own));
foreach(var u in new[]{"http://192.168.1.2:12345/","http://127.0.0.1:54321/","https://127.0.0.1:12345/","http://user@127.0.0.1:12345/","http://127.0.0.1:12345/other","http://localhost:12345/"})Check(!LocalPathLinks.TrustedSource(u,own));
Check(LocalPathLinks.ReadMessage("{\"type\":\"revealLocalPath\",\"path\":\"C:/file.txt\"}")=="C:/file.txt");
Reject(()=>LocalPathLinks.ReadMessage("{\"type\":\"revealLocalPath\",\"path\":\"C:/x\",\"extra\":true}"));
var plan=LocalPathLinks.Explorer(@"C:\space name\x.cmd",false);Check(!plan.UseShellExecute&&plan.ArgumentList.Count==1&&plan.ArgumentList[0]==@"/select,C:\space name\x.cmd");
var fixture=Path.Combine(Path.GetTempPath(),"local-links-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(fixture);var file=Path.Combine(fixture,"space 文件.txt");File.WriteAllText(file,"fixture");Check(LocalPathLinks.ValidateExisting(file)==false);Check(LocalPathLinks.ValidateExisting(fixture));Reject(()=>LocalPathLinks.ValidateExisting(Path.Combine(fixture,"missing")));
Console.WriteLine($"PASS {count} local path/link policy tests; fixture only, no Explorer/app launched.");
