using CodexLight.Migration;
static class ManualPlanTests {
 public static int Run(string root){int count=0;void Reject(Action action){bool rejected=false;try{action();}catch(IOException){rejected=true;}if(!rejected)throw new Exception("Invalid handoff accepted");count++;}
 var hash=new string('a',64);var other=new string('b',64);var legacy=new LegacyInstall("{11223344-5566-7788-9900-AABBCCDDEEFF}",MigrationCoordinator.UpgradeCode,"0.4.3",root,Path.Combine(root,"source.msi"),hash);var failed=new StageReceipt("RecoveryRequired",legacy,root,hash,hash,"0.4.3",root);var failedPath=Path.Combine(root,"plan-failed.json");MigrationStorage.AtomicReceipt(failedPath,failed);var failedHash=MigrationCoordinator.Hash(failedPath);
 var plan=failed with{Phase="ManualHandoffPlanned",ManifestSha256=other,SetupSha256=other,SourceFailedReceipt=failedPath,SourceFailedReceiptSha256=failedHash,PreHandoffSnapshot=Path.Combine(root,"data"),PreHandoffSnapshotSha256=hash};ManualPlan.ValidateLink(plan,failed,failedHash);count++;
 Reject(()=>ManualPlan.ValidateLink(plan,failed,hash));Reject(()=>ManualPlan.ValidateLink(plan with{Legacy=legacy with{Version="0.4.2"}},failed,failedHash));Reject(()=>ManualPlan.ValidateLink(plan with{NewRoot=root+"-other"},failed,failedHash));Reject(()=>ManualPlan.ValidateLink(plan with{Target="0.4.2"},failed,failedHash));Reject(()=>ManualPlan.ValidateLink(plan with{Phase="StagedOldPreserved"},failed,failedHash));
 var path=Path.Combine(root,"prepared-plan.json");MigrationStorage.AtomicReceipt(path,plan);var trusted=MigrationCoordinator.Hash(path);if(ManualPlan.LoadBoundPlan(path,trusted)!=plan)throw new Exception("Plan roundtrip failed");count++;
 MigrationStorage.AtomicReceipt(path,plan with{SetupSha256=hash});Reject(()=>ManualPlan.LoadBoundPlan(path,trusted));
 Reject(()=>ManualReconcile.ValidateChain(failed with{Phase="StagedOldPreserved",ManifestSha256=other,SetupSha256=other,SourceFailedReceipt=failedPath,SourceFailedReceiptSha256=failedHash}));
 var oldBytes=File.ReadAllBytes(failedPath);if(MigrationCoordinator.Hash(failedPath)!=failedHash)throw new Exception("Source failure changed");count++;
 Console.WriteLine($"PASS {count} prepared-handoff source/package/tamper checks; fixture only.");return count;
 }
}
