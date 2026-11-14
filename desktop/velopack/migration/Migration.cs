using System.Security.Cryptography;
namespace CodexLight.Migration;
public sealed record LegacyInstall(string ProductCode,string UpgradeCode,string Version,string InstallRoot,string SourceMsi,string SourceSha256);
public sealed record MigrationPlan(LegacyInstall Legacy,string NewRoot,string DataRoot,string TargetVersion,string Installer,string InstallerSha256,long RequiredFreeBytes);
public enum Phase { Planned, BackedUp, Staging, Staged, HealthChecking, ReadyToRetire, Retiring, Completed, OldPreserved, RecoveryRequired }
public sealed record Receipt(Guid Id,MigrationPlan Plan,Phase Phase,string Detail,string BackupSource="");
public sealed record HealthEvidence(bool NativeHost,bool Backend,bool ReadOnlyState,bool VersionsMatch,bool DataUnchanged);
// The host must implement these capabilities explicitly. No action is inferred from command exit alone.
public interface IMigrationHost {
 IDisposable AcquireExclusive(MigrationPlan plan);
 LegacyInstall InspectLegacy();
 bool NoRunningTasksOrProcesses(MigrationPlan plan);
 bool NewRootAbsent(MigrationPlan plan);
 long AvailableBytes(MigrationPlan plan);
 string PreserveRollbackSource(MigrationPlan plan); // verified full source outside both program roots
 void StageNew(MigrationPlan plan); // never uninstall legacy, never start real task/account traffic
 bool NewInstallationMatches(MigrationPlan plan);
 HealthEvidence CheckHealth(MigrationPlan plan); // isolated/read-only checks; cannot consume model tokens
 bool DataUnchanged(MigrationPlan plan);
 void RetireLegacy(MigrationPlan plan); // exact MSI ProductCode only, no directory delete
 bool LegacyAbsent(MigrationPlan plan);
 void Persist(Receipt receipt); // atomically persist before every side effect; outside both program roots
}
public static class MigrationCoordinator {
 public const string UpgradeCode="{C63D113F-36E4-46F6-B635-F1CE57BD166E}";
 public static string Hash(string path){using var f=File.OpenRead(path);return Convert.ToHexString(SHA256.HashData(f)).ToLowerInvariant();}
 static string Full(string path){if(!Path.IsPathFullyQualified(path))throw new InvalidOperationException("Absolute local paths required.");var p=Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);if(p.Length<4||p.StartsWith(@"\\"))throw new InvalidOperationException("Root/UNC paths forbidden.");return p;}
 static bool Contains(string root,string child)=>child.Equals(root,StringComparison.OrdinalIgnoreCase)||child.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
 static void Plain(string path){for(string? p=path;p!=null;p=Path.GetDirectoryName(p))if((File.Exists(p)||Directory.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("Reparse paths forbidden.");}
 public static void Validate(MigrationPlan plan) {
  if(!Guid.TryParseExact(plan.Legacy.ProductCode,"B",out _)||!plan.Legacy.UpgradeCode.Equals(UpgradeCode,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Wrong legacy product family.");
  if(!Version.TryParse(plan.Legacy.Version,out var old)||!Version.TryParse(plan.TargetVersion,out var next)||next<=old)throw new InvalidOperationException("Migration target must be newer.");
  var oldRoot=Full(plan.Legacy.InstallRoot);var newRoot=Full(plan.NewRoot);var data=Full(plan.DataRoot);
  if(!Path.GetFileName(newRoot).Equals("CodexLightDesktop",StringComparison.Ordinal))throw new InvalidOperationException("Dedicated CodexLightDesktop root required.");
  if(Contains(oldRoot,newRoot)||Contains(newRoot,oldRoot)||Contains(data,newRoot)||Contains(newRoot,data)||Contains(data,oldRoot)||Contains(oldRoot,data))throw new InvalidOperationException("Program and data roots must be disjoint.");
  foreach(var p in new[]{oldRoot,newRoot,data,Full(plan.Legacy.SourceMsi),Full(plan.Installer)})Plain(p);
  if(plan.RequiredFreeBytes<=0)throw new InvalidOperationException("Disk budget required.");
  if(!Hash(plan.Legacy.SourceMsi).Equals(plan.Legacy.SourceSha256,StringComparison.OrdinalIgnoreCase)||!Hash(plan.Installer).Equals(plan.InstallerSha256,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Installer/source changed.");
 }
 static void Current(MigrationPlan p,IMigrationHost host){if(host.InspectLegacy()!=p.Legacy)throw new InvalidOperationException("MSI identity/source changed.");if(!host.NoRunningTasksOrProcesses(p))throw new InvalidOperationException("Tasks/processes remain. No automatic termination permitted.");}
 public static Receipt Prepare(MigrationPlan plan,IMigrationHost host) {
  Validate(plan);using var gate=host.AcquireExclusive(plan);Current(plan,host);
  if(!host.NewRootAbsent(plan)||host.AvailableBytes(plan)<plan.RequiredFreeBytes)throw new InvalidOperationException("Destination is not empty/absent or disk budget unavailable.");
  var receipt=new Receipt(Guid.NewGuid(),plan,Phase.Planned,"");host.Persist(receipt);
  try {
   var backup=host.PreserveRollbackSource(plan);Plain(Full(backup));
   if(Contains(Full(plan.NewRoot),Full(backup))||Contains(Full(plan.Legacy.InstallRoot),Full(backup))||Contains(Full(plan.DataRoot),Full(backup))||Hash(backup)!=plan.Legacy.SourceSha256.ToLowerInvariant())throw new InvalidOperationException("Independent rollback source not verified.");
   receipt=receipt with {Phase=Phase.BackedUp,BackupSource=backup};host.Persist(receipt);
   Current(plan,host);Validate(plan);
   receipt=receipt with {Phase=Phase.Staging};host.Persist(receipt);host.StageNew(plan);
   if(!host.NewInstallationMatches(plan)||!host.DataUnchanged(plan))throw new InvalidOperationException("New installation/data verification failed.");
   receipt=receipt with {Phase=Phase.Staged};host.Persist(receipt);
   Current(plan,host);receipt=receipt with {Phase=Phase.HealthChecking};host.Persist(receipt);
   var health=host.CheckHealth(plan);
   if(!health.NativeHost||!health.Backend||!health.ReadOnlyState||!health.VersionsMatch||!health.DataUnchanged||!host.DataUnchanged(plan))throw new InvalidOperationException("Health proof incomplete; old MSI retained.");
   receipt=receipt with {Phase=Phase.ReadyToRetire};host.Persist(receipt);return receipt;
  }catch(Exception error){
   bool preserved=false;try{preserved=host.InspectLegacy()==plan.Legacy&&host.DataUnchanged(plan);}catch{}
   receipt=receipt with {Phase=preserved?Phase.OldPreserved:Phase.RecoveryRequired,Detail=error.Message};host.Persist(receipt);return receipt;
  }
 }
 public static Receipt Retire(Receipt receipt,IMigrationHost host,bool explicitlyApproved) {
  if(!explicitlyApproved||receipt.Phase!=Phase.ReadyToRetire)throw new InvalidOperationException("Verified health and explicit retirement approval required.");
  var p=receipt.Plan;Validate(p);using var gate=host.AcquireExclusive(p);Current(p,host);
  if(!host.NewInstallationMatches(p)||!host.DataUnchanged(p))throw new InvalidOperationException("New app/data changed since health verification.");
  // The persisted backup path must survive process restarts and remain a verified source.
  if(!File.Exists(receipt.BackupSource)||Hash(receipt.BackupSource)!=p.Legacy.SourceSha256.ToLowerInvariant())throw new InvalidOperationException("Rollback source missing.");
  receipt=receipt with {Phase=Phase.Retiring};host.Persist(receipt);
  try{host.RetireLegacy(p);if(!host.LegacyAbsent(p)||!host.NewInstallationMatches(p)||!host.DataUnchanged(p))throw new InvalidOperationException("Retirement outcome uncertain.");receipt=receipt with {Phase=Phase.Completed};}
  catch(Exception error){receipt=receipt with {Phase=Phase.RecoveryRequired,Detail=error.Message};}
  host.Persist(receipt);return receipt;
 }
}
