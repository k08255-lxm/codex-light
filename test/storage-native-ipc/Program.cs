using System.Text.Json;
using CodexLight.Desktop;
if(args.Length!=1)throw new InvalidOperationException("Synthetic root required");
string root=Path.GetFullPath(args[0]);
if(!root.StartsWith(Path.GetFullPath(Path.GetTempPath()),StringComparison.OrdinalIgnoreCase)||!Path.GetFileName(root).StartsWith("codecang-storage-ipc-"))throw new InvalidOperationException("Synthetic root only");
var service=new StorageNativeService(root,Path.Combine(root,"WebView","Sessions",new string('a',32)),()=>CodexLight.Shared.InstallMaintenance.Acquire(root));
while(Console.ReadLine() is { } line){using var doc=JsonDocument.Parse(line);var m=doc.RootElement;object? result=null;string? error=null;try{result=service.Execute(m.GetProperty("action").GetString()!,m.GetProperty("input"));}catch(Exception e){error=e.GetType().Name;}Console.WriteLine(JsonSerializer.Serialize(new{action="storageResult",requestId=m.GetProperty("requestId").GetString(),result,error}));}
