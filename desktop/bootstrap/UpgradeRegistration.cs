using System;using System.IO;using System.Linq;using System.Text;using System.Security.Cryptography;using System.Runtime.Serialization;using System.Runtime.Serialization.Json;using Microsoft.Win32;
namespace CodexLight.Bootstrap {
 [DataContract]internal sealed class UpgradeRegistrationRecord{
  [DataMember(Order=0)]public bool Exists;
  [DataMember(Order=1)]public string InstallLocation="";
  [DataMember(Order=2)]public string UninstallString="";
  [DataMember(Order=3)]public string InstallId="";
  [DataMember(Order=4)]public string ReceiptHash="";
 }
 // Fixed HKCU application-key adapter; never takes a registry key from journal data.
 // Write attempts to restore its own known fields on failure; restoration failure remains explicit.
 internal sealed class WindowsUpgradeRegistration:IUpgradeRegistration{
  readonly string target,keyPath;
  public WindowsUpgradeRegistration(string target){this.target=target;UpgradePlanner.ValidateIdentity(Guid.Empty.ToString("D"),target);using(var hash=SHA256.Create())keyPath=@"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexLight-"+BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(target.ToLowerInvariant()))).Replace("-","").Substring(0,16);}
  static string Serialize(UpgradeRegistrationRecord value){using(var stream=new MemoryStream()){new DataContractJsonSerializer(typeof(UpgradeRegistrationRecord)).WriteObject(stream,value);return Encoding.UTF8.GetString(stream.ToArray());}}
  internal UpgradeRegistrationRecord Parse(string value){if(value==null||value.Length>65536)throw new InvalidOperationException("Registration snapshot invalid");UpgradeRegistrationRecord data;using(var stream=new MemoryStream(Encoding.UTF8.GetBytes(value)))data=(UpgradeRegistrationRecord)new DataContractJsonSerializer(typeof(UpgradeRegistrationRecord)).ReadObject(stream)!;
   if(Serialize(data)!=value)throw new InvalidOperationException("Registration snapshot fields invalid");if(data.Exists){if(!string.Equals(data.InstallLocation,target,StringComparison.OrdinalIgnoreCase)||!string.Equals(data.UninstallString,"\""+target+"\\Uninstall.exe\" /uninstall",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Registration scope mismatch");if(data.InstallId.Length>0&&!Guid.TryParseExact(data.InstallId,"D",out _))throw new InvalidOperationException("Invalid receipt id");if(data.ReceiptHash.Length>0&&!System.Text.RegularExpressions.Regex.IsMatch(data.ReceiptHash,@"\A[0-9a-fA-F]{64}\z"))throw new InvalidOperationException("Invalid receipt hash");}else if(data.InstallLocation!=""||data.UninstallString!=""||data.InstallId!=""||data.ReceiptHash!="")throw new InvalidOperationException("Absent registration cannot contain fields");return data;
  }
  public string Next(InstallReceipt receipt){if(!string.Equals(receipt.Target,target,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Target mismatch");return Serialize(new UpgradeRegistrationRecord{Exists=true,InstallLocation=target,UninstallString="\""+target+"\\Uninstall.exe\" /uninstall",InstallId=receipt.InstallId,ReceiptHash=receipt.Fingerprint()});}
  public string Read(){using(var key=Registry.CurrentUser.OpenSubKey(keyPath,false)){if(key==null||new[]{"InstallLocation","UninstallString","InstallId","ReceiptHash"}.All(name=>key.GetValue(name,null,RegistryValueOptions.DoNotExpandEnvironmentNames)==null))return Serialize(new UpgradeRegistrationRecord());string Get(string name){var value=key.GetValue(name,null,RegistryValueOptions.DoNotExpandEnvironmentNames);if(value!=null&&!(value is string))throw new InvalidOperationException("Unexpected registry value kind");return (string?)value??"";}var data=new UpgradeRegistrationRecord{Exists=true,InstallLocation=Get("InstallLocation"),UninstallString=Get("UninstallString"),InstallId=Get("InstallId"),ReceiptHash=Get("ReceiptHash")};string serialized=Serialize(data);Parse(serialized);return serialized;}}
  void Set(UpgradeRegistrationRecord value){if(!value.Exists){using(var key=Registry.CurrentUser.OpenSubKey(keyPath,true)){if(key==null)return;foreach(var name in new[]{"InstallLocation","UninstallString","InstallId","ReceiptHash"})key.DeleteValue(name,false);}return;}using(var key=Registry.CurrentUser.CreateSubKey(keyPath)){key!.SetValue("InstallLocation",value.InstallLocation);key.SetValue("UninstallString",value.UninstallString);key.SetValue("InstallId",value.InstallId);key.SetValue("ReceiptHash",value.ReceiptHash);}}
  public void Write(string value){var next=Parse(value);var previous=Parse(Read());try{Set(next);}catch{try{Set(previous);}catch{throw new InvalidOperationException("Application registration update and restoration both failed; manual recovery required");}throw;}}
 }
}
