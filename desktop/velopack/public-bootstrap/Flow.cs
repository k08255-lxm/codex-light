using System;
namespace CodexLight.PublicSetup {
 internal interface IMigrationSteps { string Stage(); void Retire(string receipt); string ReadOutcome(string receipt); }
 internal static class BootstrapFlow {
  internal static int Run(IMigrationSteps host){
   var receipt=host.Stage();if(string.IsNullOrWhiteSpace(receipt))throw new InvalidOperationException("Stage receipt missing");
   host.Retire(receipt);
   var outcome=host.ReadOutcome(receipt);
   if(outcome=="RestartRequired")return 3010;
   if(outcome!="OldMsiRetired")throw new InvalidOperationException("Retirement not confirmed");
   return 0;
  }
 }
}
