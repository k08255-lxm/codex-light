export const remoteStatusLabel=status=>({disabled:'已停用',connecting:'连接中',connected:'已连接（未验证手机端）',errored:'连接错误'})[status]||'未知 / 尚未支持';
export function pairingExpiry(value){if(!Number.isSafeInteger(value)||value<0||!Number.isSafeInteger(value*1000)||value*1000>8640000000000000)return NaN;return value*1000;}
export function safePairing(result,now=Date.now()){const expiresAt=pairingExpiry(result?.expiresAt);if(!Number.isFinite(expiresAt)||expiresAt<=now)return null;const pairingCode=typeof result?.pairingCode==='string'?result.pairingCode:null;const manualPairingCode=typeof result?.manualPairingCode==='string'?result.manualPairingCode:null;if(!pairingCode&&!manualPairingCode)return null;return {pairingCode,manualPairingCode,expiresAt};}
export function pairingQuery(pair,now=Date.now()){if(!pair||pair.expiresAt<=now)return null;return pair.pairingCode?{pairingCode:pair.pairingCode}:pair.manualPairingCode?{manualPairingCode:pair.manualPairingCode}:null;}
export function remoteEnvironmentId(status){return status&&typeof status.environmentId==='string'&&status.environmentId?status.environmentId:null;}
export function remoteEnvironmentChanged(previous,next){return remoteEnvironmentId(previous)!==remoteEnvironmentId(next);}
// A device may only be revoked for the environment currently confirmed by the server.
export function canRevokeDevice(status,environmentId){return !!status&&status.status==='connected'&&typeof environmentId==='string'&&environmentId!==''&&status.environmentId===environmentId;}
// Read-only refresh stays available, but mutating actions require a known,
// applicable state. A pending/unknown mutation always blocks them.
export function remoteActionState({connected=false,busy=false,pending=false,status=null,pair=null,now=Date.now()}={}){
 const kind=status&&['disabled','connecting','connected','errored'].includes(status.status)?status.status:null;
 const ready=!!connected&&!busy&&!pending;
 const pairActive=!!pairingQuery(pair,now);
 return {refresh:!!connected&&!busy,enable:ready&&(kind==='disabled'||kind==='errored'),disable:ready&&(kind==='connected'||kind==='connecting'),pair:ready&&kind==='connected',pairCheck:ready&&kind==='connected'&&pairActive,revoke:ready&&kind==='connected'};
}
