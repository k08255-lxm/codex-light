using System;
using System.Threading.Tasks;
namespace CodexLight.SetupWrapper {
 internal enum NodeState { Ready, Missing, Uncertain, UpgradeRequired }
 internal interface IInstallHost { void RequireFresh(); void VerifyVendor(); Task<NodeState> DetectNode(); bool ConsentNode(); Task<int> InstallNode(); Task<NodeState> DetectCli(); bool ConsentCli(); Task<int> InstallCli(); Task<int> RunVendor(); }
 internal static class InstallFlow {
  internal static bool BridgeCompatible(string value)=>Version.TryParse(value.TrimStart('v'),out var version)&&version>=new Version(22,15,0);
  internal static async Task<int> Run(IInstallHost host){
   host.RequireFresh();host.VerifyVendor();
   var node=await host.DetectNode();
   if(node==NodeState.Uncertain)throw new InvalidOperationException("无法确定 Node.js 状态，已停止。请先修复现有环境，未启动应用安装。 ");
   if(node==NodeState.Missing||node==NodeState.UpgradeRequired){
    if(!host.ConsentNode())return 1602;
    var result=await host.InstallNode();
    if(result==3010||result==1641)return 3010;
    if(result!=0)return result;
    if(await host.DetectNode()!=NodeState.Ready)throw new InvalidOperationException("Node.js 安装后复检未通过，已停止。 ");
   }
   var cli=await host.DetectCli();
   if(cli==NodeState.Uncertain)throw new InvalidOperationException("无法确定 Codex CLI 状态，已停止，不会改动已有配置。 ");
   if(cli==NodeState.Missing){
    if(!host.ConsentCli())return 1602;
    var result=await host.InstallCli();
    if(result==3010||result==1641)return 3010;
    if(result!=0)return result;
    if(await host.DetectCli()!=NodeState.Ready)throw new InvalidOperationException("Codex CLI 安装后复检未通过，已停止。 ");
   }
   host.RequireFresh();host.VerifyVendor();
   return await host.RunVendor();
  }
 }
}
