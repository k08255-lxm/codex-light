using System;
using System.Threading.Tasks;
using CodexLight.SetupWrapper;
internal class Fake:IInstallHost {
 public NodeState Before=NodeState.Ready,After=NodeState.Ready,CliBefore=NodeState.Ready,CliAfter=NodeState.Ready;public bool Consent=true,CliConsent=true,Fresh=true,Valid=true,FreshAfter=true,ValidAfter=true,CancelNode=false,CancelCli=false;public int NodeCode,CliCode,VendorCode,Detections,CliDetections,NodeCalls,CliCalls,VendorCalls,Checks,Verifies;
 public void RequireFresh(){Checks++;if(!Fresh||(Checks>1&&!FreshAfter))throw new InvalidOperationException();}
 public void VerifyVendor(){Verifies++;if(!Valid||(Verifies>1&&!ValidAfter))throw new InvalidOperationException();}
 public Task<NodeState> DetectNode(){Detections++;return Task.FromResult(Detections==1?Before:After);}
 public bool ConsentNode()=>Consent;
 public Task<int> InstallNode(){NodeCalls++;if(CancelNode)throw new OperationCanceledException();return Task.FromResult(NodeCode);}
 public Task<NodeState> DetectCli(){CliDetections++;return Task.FromResult(CliDetections==1?CliBefore:CliAfter);}
 public bool ConsentCli()=>CliConsent;
 public Task<int> InstallCli(){CliCalls++;if(CancelCli)throw new OperationCanceledException();return Task.FromResult(CliCode);}
 public Task<int> RunVendor(){VendorCalls++;return Task.FromResult(VendorCode);}
}
internal class Program {
 static int tests;
 static void A(bool ok){if(!ok)throw new Exception("assert");tests++;}
 static async Task<int> Main(){
  var ready=new Fake();A(await InstallFlow.Run(ready)==0);A(ready.NodeCalls==0&&ready.VendorCalls==1&&ready.Checks==2&&ready.Verifies==2);
  var missing=new Fake{Before=NodeState.Missing};A(await InstallFlow.Run(missing)==0);A(missing.NodeCalls==1&&missing.Detections==2&&missing.VendorCalls==1);
  var denied=new Fake{Before=NodeState.Missing,Consent=false};A(await InstallFlow.Run(denied)==1602);A(denied.NodeCalls==0&&denied.VendorCalls==0);
  foreach(var code in new[]{1602,1,3010,1641}){var f=new Fake{Before=NodeState.Missing,NodeCode=code};A(await InstallFlow.Run(f)==(code==1641?3010:code));A(f.VendorCalls==0);}
  foreach(var f in new[]{new Fake{Before=NodeState.Uncertain},new Fake{Before=NodeState.Missing,After=NodeState.Missing},new Fake{Before=NodeState.Missing,After=NodeState.Uncertain},new Fake{Fresh=false},new Fake{Valid=false}}){try{await InstallFlow.Run(f);throw new Exception("not rejected");}catch(InvalidOperationException){A(f.VendorCalls==0);}}
  var bad=new Fake{VendorCode=5};A(await InstallFlow.Run(bad)==5);A(bad.VendorCalls==1);
  foreach(var node in new[]{NodeState.Ready,NodeState.Missing,NodeState.UpgradeRequired})foreach(var cli in new[]{NodeState.Ready,NodeState.Missing}){var f=new Fake{Before=node,CliBefore=cli};A(await InstallFlow.Run(f)==0);A(f.NodeCalls==(node==NodeState.Ready?0:1)&&f.CliCalls==(cli==NodeState.Missing?1:0)&&f.VendorCalls==1);}
  var cliDenied=new Fake{CliBefore=NodeState.Missing,CliConsent=false};A(await InstallFlow.Run(cliDenied)==1602);A(cliDenied.CliCalls==0&&cliDenied.VendorCalls==0);
  foreach(var code in new[]{1602,1603,3010,1641}){var f=new Fake{CliBefore=NodeState.Missing,CliCode=code};A(await InstallFlow.Run(f)==(code==1641?3010:code));A(f.VendorCalls==0);}
  foreach(var f in new[]{new Fake{CliBefore=NodeState.Uncertain},new Fake{CliBefore=NodeState.Missing,CliAfter=NodeState.Missing},new Fake{CliBefore=NodeState.Missing,CliAfter=NodeState.Uncertain}}){try{await InstallFlow.Run(f);throw new Exception("not rejected");}catch(InvalidOperationException){A(f.VendorCalls==0);}}
  foreach(var f in new[]{new Fake{FreshAfter=false},new Fake{ValidAfter=false}}){try{await InstallFlow.Run(f);throw new Exception("not rejected");}catch(InvalidOperationException){A(f.VendorCalls==0);}}
  foreach(var f in new[]{new Fake{Before=NodeState.Missing,CancelNode=true},new Fake{CliBefore=NodeState.Missing,CancelCli=true}}){try{await InstallFlow.Run(f);throw new Exception("not cancelled");}catch(OperationCanceledException){A(f.VendorCalls==0);}}
  foreach(var version in new[]{"v20.19.0","v22.14.0","garbage"})A(!InstallFlow.BridgeCompatible(version));
  foreach(var version in new[]{"v22.15.0","v24.13.0","v23.0.0"})A(InstallFlow.BridgeCompatible(version));
  var upgradeDeclined=new Fake{Before=NodeState.UpgradeRequired,Consent=false};A(await InstallFlow.Run(upgradeDeclined)==1602);A(upgradeDeclined.NodeCalls==0&&upgradeDeclined.VendorCalls==0);
  Console.WriteLine(tests+" safe flow assertions passed; no actual process/download/installation.");return 0;
 }
}
