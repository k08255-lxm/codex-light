using CodexLight.Migration;
var root=Path.Combine(Path.GetTempPath(),"codex-light-migration-tests-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
var source=Path.Combine(root,"old.msi");var setup=Path.Combine(root,"new.exe");File.WriteAllText(source,"not a real MSI, isolated fake host");File.WriteAllText(setup,"not executable");
var legacy=new LegacyInstall("{11223344-5566-7788-9900-AABBCCDDEEFF}",MigrationCoordinator.UpgradeCode,"0.4.3",Path.Combine(root,"Legacy"),source,MigrationCoordinator.Hash(source));
var plan=new MigrationPlan(legacy,Path.Combine(root,"CodexLightDesktop"),Path.Combine(root,"Data"),"0.4.4",setup,MigrationCoordinator.Hash(setup),1024);
int count=0;void Check(bool ok,string name){count++;if(!ok)throw new Exception(name);}void Reject(Action action,string name){try{action();throw new Exception("not rejected: "+name);}catch(InvalidOperationException){count++;}}
MigrationCoordinator.Validate(plan);Check(true,"plan accepted");
Reject(()=>MigrationCoordinator.Validate(plan with {NewRoot=plan.DataRoot}),"data collision");
Reject(()=>MigrationCoordinator.Validate(plan with {Legacy=legacy with {UpgradeCode=Guid.NewGuid().ToString()}}),"wrong product");
Reject(()=>MigrationCoordinator.Validate(plan with {TargetVersion="0.4.2"}),"downgrade");
Reject(()=>MigrationCoordinator.Validate(plan with {InstallerSha256=new string('0',64)}),"changed artifact");
Reject(()=>MigrationCoordinator.Validate(plan with {NewRoot=Path.Combine(plan.DataRoot,"CodexLightDesktop")}),"nested program/data");
var host=new Fake(plan,root);var receipt=MigrationCoordinator.Prepare(plan,host);Check(receipt.Phase==Phase.ReadyToRetire,"health before retirement");Check(host.Retires==0,"prepare never retires old");Check(File.Exists(receipt.BackupSource),"backup verified");
Reject(()=>MigrationCoordinator.Retire(receipt,host,false),"approval required");
host.Busy=true;Reject(()=>MigrationCoordinator.Retire(receipt,host,true),"running task blocks retirement");host.Busy=false;
var completed=MigrationCoordinator.Retire(receipt,host,true);Check(completed.Phase==Phase.Completed&&host.Retires==1,"retirement explicit");
host=new Fake(plan,root){Healthy=false};receipt=MigrationCoordinator.Prepare(plan,host);Check(receipt.Phase==Phase.OldPreserved&&host.Retires==0,"failed health preserves old");
host=new Fake(plan,root){ThrowStage=true};receipt=MigrationCoordinator.Prepare(plan,host);Check(receipt.Phase==Phase.OldPreserved&&host.Retires==0,"stage failure preserves old");
host=new Fake(plan,root){MutatedData=true};receipt=MigrationCoordinator.Prepare(plan,host);Check(receipt.Phase==Phase.RecoveryRequired&&host.Retires==0,"data mismatch needs recovery");
host=new Fake(plan,root){Busy=true};Reject(()=>MigrationCoordinator.Prepare(plan,host),"busy before staging");Check(host.Stages==0,"busy no stage");
host=new Fake(plan,root){FreeBytes=0};Reject(()=>MigrationCoordinator.Prepare(plan,host),"space shortage");
host=new Fake(plan,root){RootAbsent=false};Reject(()=>MigrationCoordinator.Prepare(plan,host),"existing destination");
host=new Fake(plan,root);receipt=MigrationCoordinator.Prepare(plan,host);host.FailRetire=true;var failed=MigrationCoordinator.Retire(receipt,host,true);Check(failed.Phase==Phase.RecoveryRequired,"uncertain uninstall does not claim old retained");
Check(host.Phases.IndexOf(Phase.Retiring)<host.Phases.IndexOf(Phase.RecoveryRequired),"journal precedes side effect");
Console.WriteLine($"PASS {count} isolated migration checks; no real installation. Fixtures: {root}");
sealed class Fake(MigrationPlan plan,string root):IMigrationHost {
 public bool Busy,Healthy=true,ThrowStage,MutatedData,RootAbsent=true,FailRetire;public long FreeBytes=100000;public int Stages,Retires;public List<Phase> Phases=new();
 public IDisposable AcquireExclusive(MigrationPlan p)=>new Gate();
 public LegacyInstall InspectLegacy()=>plan.Legacy;
 public bool NoRunningTasksOrProcesses(MigrationPlan p)=>!Busy;
 public bool NewRootAbsent(MigrationPlan p)=>RootAbsent;
 public long AvailableBytes(MigrationPlan p)=>FreeBytes;
 public string PreserveRollbackSource(MigrationPlan p){var name=Path.Combine(root,Guid.NewGuid()+".msi");File.Copy(p.Legacy.SourceMsi,name);return name;}
 public void StageNew(MigrationPlan p){Stages++;if(ThrowStage)throw new IOException("simulated stage failure");}
 public bool NewInstallationMatches(MigrationPlan p)=>true;
 public HealthEvidence CheckHealth(MigrationPlan p)=>new(Healthy,Healthy,Healthy,Healthy,!MutatedData);
 public bool DataUnchanged(MigrationPlan p)=>!MutatedData;
 public void RetireLegacy(MigrationPlan p){Retires++;if(FailRetire)throw new IOException("outcome unknown");}
 public bool LegacyAbsent(MigrationPlan p)=>Retires>0;
 public void Persist(Receipt r)=>Phases.Add(r.Phase);
 sealed class Gate:IDisposable{public void Dispose(){}}
}
