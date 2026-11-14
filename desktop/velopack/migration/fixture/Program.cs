using System.Security.Cryptography;
using System.Text.Json;
Velopack.VelopackApp.Build().SetArgs(args).SetAutoApplyOnStartup(false).Run();
if(args.Length!=1||args[0]!="--fixture-health")return 0;
try {
 var root=AppContext.BaseDirectory;
 var records=JsonSerializer.Deserialize<Dictionary<string,string>>(File.ReadAllText(Path.Combine(root,"fixture-hashes.json")))!;
 foreach(var record in records) {
  var file=Path.GetFullPath(Path.Combine(root,record.Key));
  if(!file.StartsWith(root,StringComparison.OrdinalIgnoreCase)||(File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)return 21;
  using var stream=File.OpenRead(file);
  if(Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant()!=record.Value)return 22;
 }
 return 0;
}catch{return 23;}
