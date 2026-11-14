using System.Text.Json;
using CodexLight.Migration;
using CodexLight.PublicSetup;
try {
 if(args.Length!=2||args[0]!="--install")return 2;
 return BootstrapFlow.Run(new Steps(Path.GetFullPath(args[1])));
}catch(Exception error){Console.Error.WriteLine(error.ToString());return 1;}
sealed class Steps:IMigrationSteps {
 readonly string manifest,hash,setup;
 internal Steps(string root){manifest=Path.Combine(root,"release","migration-release.json");var pins=JsonSerializer.Deserialize<Dictionary<string,string>>(File.ReadAllText(Path.Combine(root,"migration-pins.json")))??throw new IOException("Missing pins");hash=pins["manifestSha256"];setup=pins["setupSha256"];}
 public string Stage(){Console.WriteLine("STAGE: preserve old installation and check new payload");var receipt=SafeStage.Execute(manifest,hash,setup,true,false,true)??throw new IOException("Stage did not return a receipt");Console.WriteLine("STAGE_RECEIPT="+receipt);return receipt;}
 public void Retire(string receipt){Console.WriteLine("SWITCH: health and data checks passed; retire exact old MSI");SafeRetire.RetireVerified(receipt,manifest,hash,setup,true);}
 public string ReadOutcome(string receipt){using var result=JsonDocument.Parse(File.ReadAllText(Path.Combine(Path.GetDirectoryName(receipt)!,"retirement.json")));return result.RootElement.GetProperty("Phase").GetString()??"";}
}
