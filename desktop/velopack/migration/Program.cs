using System.Text.Json;
using CodexLight.Migration;
if(args.Length!=1||args[0]!="inspect") {Console.WriteLine("Read-only: Migration inspect. No install/uninstall executor is bundled.");return 2;}
try {Console.WriteLine(JsonSerializer.Serialize(MsiProbe.ReadCurrentUser(),new JsonSerializerOptions{WriteIndented=true}));return 0;}
catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}
