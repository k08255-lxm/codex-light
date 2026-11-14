import {spawn} from 'node:child_process';
import {lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const MAX=16384;
const failure=()=>Object.assign(new Error('无法安全读取或保存局域网恢复设置；未使用明文替代。'),{code:'LAN_PERSISTENCE_FAILED',status:409});
function powershell(script,input){return new Promise((resolve,reject)=>{
 const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const child=spawn(exe,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='';let failed=false;
 const timer=setTimeout(()=>{failed=true;child.kill();reject(failure());},10000);
 child.stdout.on('data',b=>{out+=b.toString();if(out.length>MAX*2){failed=true;child.kill();reject(failure());}});child.stderr.on('data',()=>{});
 child.on('error',()=>{clearTimeout(timer);reject(failure());});child.on('close',code=>{clearTimeout(timer);if(failed)return;code===0?resolve(out.trim()):reject(failure());});child.stdin.on('error',()=>{});child.stdin.end(input);
});}
export async function dpapi(bytes,mode){
 if(process.platform!=='win32'||!['protect','unprotect'].includes(mode))throw failure();
 const method=mode==='protect'?'Protect':'Unprotect';
 const text=await powershell(`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());$o=[Security.Cryptography.ProtectedData]::${method}($b,[Text.Encoding]::UTF8.GetBytes('CodexLight.Lan.v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Convert]::ToBase64String($o))`,bytes.toString('base64'));
 if(!/^[A-Za-z0-9+/=]+$/.test(text))throw failure();return Buffer.from(text,'base64');
}
export async function windowsNetworkIdentity(name){
 if(process.platform!=='win32')throw failure();
 // NLM GUID retval values cannot be safely marshalled via PowerShell's dynamic
 // IDispatch binder. These typed slots follow Microsoft's netlistmgr.h vtable.
 const output=await powershell(`$ErrorActionPreference='Stop';
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("DCB00002-570F-4A9B-8D69-199FDBA5723B"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
public interface INetworkIdentity {
 [return:MarshalAs(UnmanagedType.BStr)] string GetName();
 void SetName([MarshalAs(UnmanagedType.BStr)] string value);
 [return:MarshalAs(UnmanagedType.BStr)] string GetDescription();
 void SetDescription([MarshalAs(UnmanagedType.BStr)] string value);
 Guid GetNetworkId();
}
[ComImport, Guid("DCB00005-570F-4A9B-8D69-199FDBA5723B"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
public interface IConnectionIdentity {
 [return:MarshalAs(UnmanagedType.Interface)] object GetNetwork();
 [return:MarshalAs(UnmanagedType.VariantBool)] bool IsConnectedToInternet();
 [return:MarshalAs(UnmanagedType.VariantBool)] bool IsConnected();
 int GetConnectivity();
 Guid GetConnectionId();
 Guid GetAdapterId();
}
public static class NlmIdentity {
 public static Guid Network(object value) { return ((INetworkIdentity)value).GetNetworkId(); }
 public static Guid Adapter(object value) { return ((IConnectionIdentity)value).GetAdapterId(); }
}
"@

$name=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));$adapter=@([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object {$_.Name -ceq $name});if($adapter.Count -ne 1){throw 'adapter'};$manager=[Activator]::CreateInstance([type]::GetTypeFromCLSID([guid]'DCB00C01-570F-4A9B-8D69-199FDBA5723B'));$found=@();foreach($network in $manager.GetNetworks(1)){foreach($connection in $network.GetNetworkConnections()){if([NlmIdentity]::Adapter($connection) -eq [guid]$adapter[0].Id){$category=$network.GetCategory();if($category -ne 1 -and $category -ne 2){throw 'untrusted network'};$id=[NlmIdentity]::Network($network);if($id -eq [guid]::Empty){throw 'network'};$found+=$id.ToString('D')}}};if($found.Count -ne 1){throw 'network'};[Console]::Write($found[0])`,Buffer.from(name).toString('base64'));
 if(!/^[a-f0-9-]{36}$/i.test(output))throw failure();return createHash('sha256').update(output.toLowerCase()).digest('hex');
}
export function validateLanPreference(v){
 if(v===null)return null;
 if(!v||Object.keys(v).sort().join(',')!=='address,network,port,token,version'||v.version!==1||typeof v.address!=='string'||!Number.isInteger(v.port)||v.port<1||v.port>65535||! /^[a-f0-9]{64}$/.test(v.token)||! /^[a-f0-9]{64}$/.test(v.network))throw failure();
 return {...v};
}
async function noLinks(file){for(let p=path.resolve(file);;p=path.dirname(p)){try{if((await lstat(p)).isSymbolicLink())throw failure();}catch(e){if(e.code!=='ENOENT')throw e;}if(path.dirname(p)===p)break;}}
export class LanPreferenceStore{
 constructor({root,crypt=dpapi}={}){if(!root||!path.isAbsolute(root))throw failure();this.root=root;this.file=path.join(root,'lan.dpapi');this.crypt=crypt;}
 async read(){await noLinks(this.file);let h;try{h=await open(this.file,'r');const s=await h.stat();if(!s.isFile()||s.size>MAX)throw failure();const b=await h.readFile();if(b.length>MAX)throw failure();return validateLanPreference(JSON.parse((await this.crypt(b,'unprotect')).toString('utf8')));}catch(e){if(e.code==='ENOENT')return null;throw failure();}finally{await h?.close();}}
 async write(value){validateLanPreference(value);await noLinks(this.file);await mkdir(this.root,{recursive:true,mode:0o700});const bytes=await this.crypt(Buffer.from(JSON.stringify(value)),'protect');if(bytes.length>MAX)throw failure();const temp=path.join(this.root,'.lan-'+randomBytes(16).toString('hex'));let h;try{h=await open(temp,'wx',0o600);await h.writeFile(bytes);await h.sync();await h.close();h=null;await noLinks(this.file);await rename(temp,this.file);}catch{throw failure();}finally{await h?.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
}
