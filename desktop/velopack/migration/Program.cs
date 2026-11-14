using System.Text.Json;
using CodexLight.Migration;
try {
 if(args.Length==1&&args[0]=="inspect"){Console.WriteLine(JsonSerializer.Serialize(MsiProbe.ReadCurrentUser(),new JsonSerializerOptions{WriteIndented=true}));return 0;}
 if(args.Length>=4&&args.Length<=7&&args[0]=="stage-plan"&&args.Skip(4).All(x=>x is "--execute-stage" or "--allow-same-version" or "--tasks-completed")){SafeStage.Execute(args[1],args[2],args[3],args.Contains("--execute-stage"),args.Contains("--allow-same-version"),args.Contains("--tasks-completed"));return 0;}
 if(args.Length>=5&&args.Length<=8&&args[0]=="retire-plan"&&args.Skip(5).All(x=>x is "--execute-retire" or "--tasks-completed" or "--confirm-retirement")){SafeRetire.Retire(args[1],args[2],args[3],args[4],args.Contains("--execute-retire"),args.Contains("--tasks-completed"),args.Contains("--confirm-retirement"));return 0;}
 if(args.Length==6&&args[0]=="observe-gui"&&args[5]=="--confirm-real-use"){SafeRetire.ObserveGui(args[1],args[2],args[3],args[4],true);return 0;}
 if(args.Length==6&&args[0]=="create-migration-shortcut"&&args[5]=="--create-shortcut"){SafeRetire.Shortcut(args[1],args[2],args[3],args[4]);return 0;}
 Console.WriteLine("Migration inspect | stage-plan MANIFEST TRUSTED_MANIFEST_SHA256 TRUSTED_SETUP_SHA256 [--allow-same-version] [--execute-stage --tasks-completed]. Separate retire-plan requires receipt, GUI observation and explicit confirmation.");return 2;
}catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}
