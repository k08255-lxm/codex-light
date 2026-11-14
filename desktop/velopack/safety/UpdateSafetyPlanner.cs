using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
namespace CodexLight.Updates {
 public enum UpdatePhase { Stage, Activate, RetireLegacy, RollBack }
 public enum SafetyDecision { Blocked, StageOnly, RequestGracefulStop, ApplyWhileStopped, RetireLegacyWhileStopped, RestorePreviousWhileStopped }
 public enum TasksState { Unknown, Idle, Active }
 // A factual snapshot supplied by a trusted local observer; never accept these fields from a web message.
 public sealed class UpdateSafetySnapshot {
  public UpdatePhase Phase;
  public string ProgramRoot="", LegacyRoot="", UserDataRoot="", PackageId="", ExpectedPackageId="CodexLightDesktop";
  public string TargetVersion="", VerifiedPackageVersion="";
  public bool PackageHashVerified, PackageIdentityVerified, PathsCheckedNoReparse, MaintenanceLeaseHeld;
  public bool TargetRootEmpty, TargetOwnedByExpectedPackage, IsLegacyMsi;
  public string ExpectedMsiProductCode="", ObservedMsiProductCode="", ExpectedMsiVersion="", ObservedMsiVersion="";
  public string ExpectedMsiSource="", ObservedMsiSource="";
  public bool MsiInstalled, MsiUpgradeCodeVerified, MsiSourceHashVerified, RetainedMsiSourceVerified;
  public bool PreviousFailureUnresolved, RestartPending, MigrationApproved, RetirementApproved, RollbackApproved;
  public bool NewAppHealthy, NewVersionObserved, PreviousPackageVerified, DataBackwardCompatible;
  public TasksState Tasks;
  public bool InterruptionApproved, ApplicationProcessesStopped;
  public DateTime ObservedUtc, NowUtc;
 }
 public sealed class UpdateSafetyPlan {
  public SafetyDecision Decision {get;}
  public string Reason {get;}
  public bool MayMutateInstalledFiles => Decision==SafetyDecision.ApplyWhileStopped || Decision==SafetyDecision.RetireLegacyWhileStopped || Decision==SafetyDecision.RestorePreviousWhileStopped;
  public bool MayForceKill => false;
  public bool KeepPreviousPackage => true;
  public bool KeepMsiSource => true;
  public bool MayTouchUserData => false;
  public IReadOnlyList<string> RequiredLockRoots {get;}
  internal UpdateSafetyPlan(SafetyDecision decision,string reason,IEnumerable<string> roots){Decision=decision;Reason=reason;RequiredLockRoots=roots.Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(x=>x,StringComparer.OrdinalIgnoreCase).ToArray();}
 }
 public static class UpdateSafetyPlanner {
  // Pure Windows lexical validation. Caller separately checks every real ancestor for links and takes locks.
  public static string CanonicalRoot(string path) {
   if(string.IsNullOrWhiteSpace(path)||!Regex.IsMatch(path,@"^[A-Za-z]:\\"))throw new ArgumentException("Local absolute Windows path required");
   path=path.TrimEnd('\\');
   if(path.Length<=3)throw new ArgumentException("Drive root forbidden");
   var pieces=path.Substring(3).Split('\\');
   foreach(var part in pieces){
    if(part.Length==0||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" ")||part.IndexOfAny(new[]{'/','\0','\r','\n',':','*','?','"','<','>','|'})>=0||part.Any(c=>c<32))throw new ArgumentException("Noncanonical Windows path");
    var stem=part.Split('.')[0];if(Regex.IsMatch(stem,@"^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$",RegexOptions.IgnoreCase))throw new ArgumentException("Device path forbidden");
   }
   return char.ToUpperInvariant(path[0])+path.Substring(1);
  }
  static bool Same(string a,string b)=>string.Equals(CanonicalRoot(a),CanonicalRoot(b),StringComparison.OrdinalIgnoreCase);
  static bool Overlap(string a,string b)=>Same(a,b)||a.StartsWith(b+"\\",StringComparison.OrdinalIgnoreCase)||b.StartsWith(a+"\\",StringComparison.OrdinalIgnoreCase);
  public static UpdateSafetyPlan Evaluate(UpdateSafetySnapshot s) {
   if(s==null)throw new ArgumentNullException(nameof(s));
   var roots=new List<string>();
   UpdateSafetyPlan Block(string reason)=>new UpdateSafetyPlan(SafetyDecision.Blocked,reason,roots);
   string program,data,legacy="";
   try{program=CanonicalRoot(s.ProgramRoot);data=CanonicalRoot(s.UserDataRoot);roots.Add(program);if(s.IsLegacyMsi){legacy=CanonicalRoot(s.LegacyRoot);roots.Add(legacy);}}
   catch(ArgumentException){return Block("unsafe-path");}
   if(Overlap(program,data)||(s.IsLegacyMsi&&(Overlap(legacy,data)||Overlap(legacy,program))))return Block("program-data-or-legacy-roots-overlap");
   if(!s.PathsCheckedNoReparse||!s.MaintenanceLeaseHeld)return Block("path-and-maintenance-evidence-required");
   if(s.RestartPending||s.PreviousFailureUnresolved)return Block("resolve-restart-or-failure-first");
   if(!s.PackageIdentityVerified||!s.PackageHashVerified||s.PackageId!=s.ExpectedPackageId||s.ExpectedPackageId!="CodexLightDesktop")return Block("unverified-package");
   if(!Version.TryParse(s.TargetVersion,out var version)||version.Build<0||s.TargetVersion!=s.VerifiedPackageVersion)return Block("version-mismatch");
   if(s.IsLegacyMsi){
    if(!s.MigrationApproved)return Block("migration-consent-required");
    if(!s.MsiInstalled||!s.MsiUpgradeCodeVerified||!Guid.TryParse(s.ExpectedMsiProductCode,out var expected)||!Guid.TryParse(s.ObservedMsiProductCode,out var observed)||expected!=observed||s.ExpectedMsiVersion!=s.ObservedMsiVersion||string.IsNullOrWhiteSpace(s.ExpectedMsiVersion))return Block("msi-identity-mismatch");
    try{if(!Same(s.ExpectedMsiSource,s.ObservedMsiSource))return Block("msi-source-mismatch");}catch(ArgumentException){return Block("msi-source-mismatch");}
    if(!s.MsiSourceHashVerified||!s.RetainedMsiSourceVerified)return Block("retain-verified-msi-source-first");
   }
   if(s.Phase==UpdatePhase.Stage){
    if(!s.TargetRootEmpty)return Block("stage-requires-new-empty-root");
    return new UpdateSafetyPlan(SafetyDecision.StageOnly,"stage-without-changing-legacy-or-user-data",roots);
   }
   if(!s.TargetOwnedByExpectedPackage)return Block("target-ownership-unproven");
   if(s.ObservedUtc.Kind!=DateTimeKind.Utc||s.NowUtc.Kind!=DateTimeKind.Utc||s.ObservedUtc>s.NowUtc||s.NowUtc-s.ObservedUtc>TimeSpan.FromSeconds(30))return Block("stale-task-process-evidence");
   if(s.Tasks==TasksState.Unknown)return Block("task-state-unknown");
   if(s.Tasks==TasksState.Active&&!s.InterruptionApproved)return Block("active-tasks-require-explicit-interruption-consent");
   if(!s.ApplicationProcessesStopped)return new UpdateSafetyPlan(SafetyDecision.RequestGracefulStop,"wait-for-observed-process-exit-never-force-kill",roots);
   if(s.Tasks==TasksState.Active)return Block("active-tasks-after-process-exit-inconsistent");
   if(s.Phase==UpdatePhase.Activate)return new UpdateSafetyPlan(SafetyDecision.ApplyWhileStopped,"apply-verified-package-retain-recovery-material",roots);
   if(s.Phase==UpdatePhase.RetireLegacy){
    if(!s.IsLegacyMsi||!s.RetirementApproved||!s.NewAppHealthy||!s.NewVersionObserved)return Block("retirement-needs-healthy-new-version-and-explicit-consent");
    return new UpdateSafetyPlan(SafetyDecision.RetireLegacyWhileStopped,"retire-exact-msi-product-only-preserve-source-and-data",roots);
   }
   if(s.Phase==UpdatePhase.RollBack){
    if(!s.RollbackApproved||!s.PreviousPackageVerified||!s.DataBackwardCompatible)return Block("rollback-needs-verified-package-data-compatibility-and-consent");
    return new UpdateSafetyPlan(SafetyDecision.RestorePreviousWhileStopped,"package-rollback-not-a-user-data-rollback",roots);
   }
   return Block("unsupported-phase");
  }
 }
}
