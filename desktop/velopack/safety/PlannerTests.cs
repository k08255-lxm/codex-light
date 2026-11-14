using System;
using CodexLight.Updates;
class PlannerTests {
 static int count;
 static readonly DateTime now=new DateTime(2026,11,14,10,0,0,DateTimeKind.Utc);
 static UpdateSafetySnapshot Valid(bool legacy=true)=>new UpdateSafetySnapshot{
  Phase=UpdatePhase.Activate,ProgramRoot=@"C:\Apps\CodexLightDesktop",LegacyRoot=@"C:\Apps\CodexLightMsi",UserDataRoot=@"C:\Users\Test\AppData\Local\CodexLight",PackageId="CodexLightDesktop",TargetVersion="0.4.4",VerifiedPackageVersion="0.4.4",PackageHashVerified=true,PackageIdentityVerified=true,PathsCheckedNoReparse=true,MaintenanceLeaseHeld=true,TargetRootEmpty=true,TargetOwnedByExpectedPackage=true,IsLegacyMsi=legacy,ExpectedMsiProductCode="7CE8194C-E962-443D-B059-F9A925711E9A",ObservedMsiProductCode="7CE8194C-E962-443D-B059-F9A925711E9A",ExpectedMsiVersion="0.4.3",ObservedMsiVersion="0.4.3",ExpectedMsiSource=@"C:\SafeMsiSource",ObservedMsiSource=@"C:\SafeMsiSource",MsiInstalled=true,MsiUpgradeCodeVerified=true,MsiSourceHashVerified=true,RetainedMsiSourceVerified=true,MigrationApproved=true,RetirementApproved=true,RollbackApproved=true,NewAppHealthy=true,NewVersionObserved=true,PreviousPackageVerified=true,DataBackwardCompatible=true,Tasks=TasksState.Idle,ApplicationProcessesStopped=true,ObservedUtc=now,NowUtc=now
 };
 static void Expect(UpdateSafetySnapshot s,SafetyDecision expected,string name){var p=UpdateSafetyPlanner.Evaluate(s);if(p.Decision!=expected)throw new Exception(name+": "+p.Decision+" / "+p.Reason);if(p.MayForceKill||p.MayTouchUserData||!p.KeepPreviousPackage||!p.KeepMsiSource)throw new Exception("invariant");count++;}
 static void Block(Action<UpdateSafetySnapshot> mutate,string name){var s=Valid();mutate(s);Expect(s,SafetyDecision.Blocked,name);}
 static void Main(){
  Expect(Valid(),SafetyDecision.ApplyWhileStopped,"legacy activation");Expect(Valid(false),SafetyDecision.ApplyWhileStopped,"existing velo activation");
  var stage=Valid();stage.Phase=UpdatePhase.Stage;stage.Tasks=TasksState.Active;stage.ApplicationProcessesStopped=false;Expect(stage,SafetyDecision.StageOnly,"independent stage does not interrupt work");
  var grace=Valid();grace.ApplicationProcessesStopped=false;Expect(grace,SafetyDecision.RequestGracefulStop,"idle but live process must exit");
  grace.Tasks=TasksState.Active;grace.InterruptionApproved=true;Expect(grace,SafetyDecision.RequestGracefulStop,"consent allows only graceful request not forced application");
  foreach(var bad in new[]{@"C:\",@"C:\Apps\..\Data",@"\\server\share",@"C:relative",@"C:\Apps\file:stream",@"C:\Apps\CON",@"C:\Apps\name.",@"C:\Apps\\child",@"C:/Apps/x"})Block(s=>s.ProgramRoot=bad,"unsafe path "+bad);
  Block(s=>s.ProgramRoot=s.UserDataRoot,"same data root");Block(s=>s.ProgramRoot=s.UserDataRoot+@"\current","nested inside data");Block(s=>s.UserDataRoot=s.ProgramRoot+@"\data","data inside program");Block(s=>s.ProgramRoot=s.LegacyRoot,"same legacy root");Block(s=>s.LegacyRoot=s.ProgramRoot+@"\old","nested legacy root");
  Block(s=>s.PathsCheckedNoReparse=false,"links unverified");Block(s=>s.MaintenanceLeaseHeld=false,"no lease");Block(s=>s.RestartPending=true,"pending reboot");Block(s=>s.PreviousFailureUnresolved=true,"unresolved journal");
  Block(s=>s.PackageHashVerified=false,"bad hash");Block(s=>s.PackageIdentityVerified=false,"bad identity");Block(s=>s.PackageId="CodexLight","data-root package ID");Block(s=>s.ExpectedPackageId="Attacker","untrusted expected identity");Block(s=>s.VerifiedPackageVersion="0.4.5","stale version");Block(s=>s.TargetVersion="invalid","invalid version");
  Block(s=>s.MigrationApproved=false,"migration not authorized");Block(s=>s.MsiInstalled=false,"MSI missing");Block(s=>s.MsiUpgradeCodeVerified=false,"wrong MSI family");Block(s=>s.ObservedMsiProductCode=Guid.NewGuid().ToString(),"wrong MSI product");Block(s=>s.ObservedMsiVersion="0.4.2","wrong MSI version");Block(s=>s.ObservedMsiSource=@"C:\OtherSource","source changed");Block(s=>s.MsiSourceHashVerified=false,"unverified source");Block(s=>s.RetainedMsiSourceVerified=false,"recovery source absent");
  Block(s=>{s.Phase=UpdatePhase.Stage;s.TargetRootEmpty=false;},"stage must not overwrite");Block(s=>s.TargetOwnedByExpectedPackage=false,"unknown target");
  Block(s=>s.Tasks=TasksState.Unknown,"unknown tasks");Block(s=>s.ObservedUtc=now.AddSeconds(-31),"stale evidence");Block(s=>s.ObservedUtc=now.AddSeconds(1),"future evidence");Block(s=>s.ObservedUtc=DateTime.SpecifyKind(now,DateTimeKind.Local),"wrong timestamp kind");Block(s=>s.Tasks=TasksState.Active,"active tasks no consent");Block(s=>{s.Tasks=TasksState.Active;s.InterruptionApproved=true;},"active state inconsistent with stopped processes");
  var retire=Valid();retire.Phase=UpdatePhase.RetireLegacy;Expect(retire,SafetyDecision.RetireLegacyWhileStopped,"explicit retirement after health proof");
  Block(s=>{s.Phase=UpdatePhase.RetireLegacy;s.NewAppHealthy=false;},"no health proof");Block(s=>{s.Phase=UpdatePhase.RetireLegacy;s.RetirementApproved=false;},"no retirement consent");Block(s=>{s.Phase=UpdatePhase.RetireLegacy;s.NewVersionObserved=false;},"no observed new version");
  var back=Valid(false);back.Phase=UpdatePhase.RollBack;Expect(back,SafetyDecision.RestorePreviousWhileStopped,"verified compatible rollback");
  Block(s=>{s.Phase=UpdatePhase.RollBack;s.DataBackwardCompatible=false;},"binary rollback is not data rollback");Block(s=>{s.Phase=UpdatePhase.RollBack;s.PreviousPackageVerified=false;},"missing previous package");Block(s=>{s.Phase=UpdatePhase.RollBack;s.RollbackApproved=false;},"rollback needs permission");
  var plan=UpdateSafetyPlanner.Evaluate(Valid());if(plan.RequiredLockRoots.Count!=2)throw new Exception("must acquire both install-root locks");count++;
  Console.WriteLine("PASS "+count+" pure migration/update safety cases; no filesystem/process/network/installer action.");
 }
}
