using CodexLight.Migration;
static class ManualTests {
 public static int Run(string root){int count=0;var a=new DataSnapshot(1,root,new[]{"WebView","recovery"},new[]{new DataFile("WebView/a",1,new string('a',64)),new DataFile("recovery/b",2,new string('b',64))},Array.Empty<string>());var b=a with{Files=new[]{new DataFile("WebView/a",3,new string('c',64)),new DataFile("state/new",4,new string('d',64))},Directories=new[]{"WebView","state"}};
 var diff=ManualReconcile.Difference(a,b);if(diff!=new DataDifference(1,1,1,3,7,1,1))throw new Exception("Manual data differences wrong");count++;
 if(ManualReconcile.Difference(a,a)!=new DataDifference(0,0,0,3,3,0,0))throw new Exception("Unchanged data misreported");count++;
 var legacy=new LegacyInstall("{11223344-5566-7788-9900-AABBCCDDEEFF}",MigrationCoordinator.UpgradeCode,"0.4.3",root,Path.Combine(root,"source.msi"),new string('a',64));var receipt=new StageReceipt("RecoveryRequired",legacy,root,"manifest","setup","0.4.3",root);ManualReconcile.RequireFailedSource(receipt);count++;
 bool rejected=false;try{ManualReconcile.RequireFailedSource(receipt with{Phase="StagedOldPreserved"});}catch(IOException){rejected=true;}if(!rejected)throw new Exception("Wrong origin phase accepted");count++;
 rejected=false;try{ManualReconcile.ValidateChain(receipt with{ReconciledSnapshot="orphan"});}catch(IOException){rejected=true;}if(!rejected)throw new Exception("Partial evidence chain accepted");count++;
 var failed=Path.Combine(root,"manual-original-failed.json");MigrationStorage.AtomicReceipt(failed,receipt);var original=File.ReadAllBytes(failed);var other=Path.Combine(root,"manual-new-evidence.json");MigrationStorage.AtomicReceipt(other,receipt with{Phase="StagedOldPreserved",SourceFailedReceipt=failed,SourceFailedReceiptSha256=MigrationCoordinator.Hash(failed)});if(!original.SequenceEqual(File.ReadAllBytes(failed)))throw new Exception("Original failure receipt mutated");count++;
 Console.WriteLine($"PASS {count} manual reconciliation difference/evidence checks; fixture files only.");return count;
 }
}
