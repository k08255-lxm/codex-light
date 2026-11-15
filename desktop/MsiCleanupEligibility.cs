using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
namespace CodexLight.Desktop;

internal sealed record MsiCleanupDecision(bool Eligible,string Reason,string? Snapshot=null,bool RequiresElevation=false,MsiPackageIdentity? Identity=null);
internal sealed record MsiPackageIdentity(string ProductCode,string UpgradeCode,string Version,string PackageCode="");
internal sealed record MsiRegistrationInventory(bool Complete,IReadOnlyList<string> ProductCodes,IReadOnlyList<string> Sources,string? Error=null,uint? ErrorCode=null);

// Read-only inspection scoped to current Windows user and machine, not other users.
internal static class MsiCleanupEligibility {
 internal const string UpgradeCode="{C63D113F-36E4-46F6-B635-F1CE57BD166E}";
 internal static bool IsCandidate(string relative)=>Regex.IsMatch(relative,@"^SetupLogs/\d{8}-\d{6}-[a-f0-9]{8}/CodexLight(?:-\d+\.\d+\.\d+-x64)?\.msi$");
 internal static MsiCleanupDecision Check(string root,string relative,MsiRegistrationInventory? inventory=null){
  if(!IsCandidate(relative))return new(false,"Not an app-owned MSI source path.");
  try{using var file=new StoragePinnedFile(root,relative,readOnly:true);if(file.Length>32L*1024*1024)return new(false,"MSI exceeds safe inspection limit.");string before=file.Snapshot();string full=StoragePinnedFile.Resolve(root,relative);var identity=ReadPackage(full);if(file.Snapshot()!=before)return new(false,"MSI changed during inspection.");var data=inventory??ReadInventory(identity.ProductCode);var result=Evaluate(full,identity,MsiQueryProductState(identity.ProductCode),data);return result with{Snapshot=result.Eligible?before:null,Identity=result.Eligible?identity:null};}
  catch(Exception e){return new(false,"MSI verification unavailable ("+(e is System.ComponentModel.Win32Exception win?win.NativeErrorCode:e is MsiReadException m?m.Code:e.HResult)+").");}
 }
 internal static MsiCleanupDecision Evaluate(string path,MsiPackageIdentity identity,int productState,MsiRegistrationInventory inventory){
  if(!Guid.TryParse(identity.PackageCode,out _)||!Guid.TryParse(identity.ProductCode,out _)||!identity.UpgradeCode.Equals(UpgradeCode,StringComparison.OrdinalIgnoreCase)||!Version.TryParse(identity.Version,out var version)||(Path.GetFileName(path)!=$"CodexLight-{version}-x64.msi"&&Path.GetFileName(path)!="CodexLight.msi"))return new(false,"MSI family or filename identity does not match.");
  if(productState!=-1)return new(false,"MSI product is registered or its state is unknown.");
  if(!inventory.Complete)return new(false,inventory.Error??"无法完整核验 Windows Installer 注册信息，已保留。",RequiresElevation:inventory.ErrorCode==5);
  if(inventory.ProductCodes.Contains(identity.ProductCode,StringComparer.OrdinalIgnoreCase))return new(false,"MSI product remains registered in another context.");
  foreach(string source in inventory.Sources){if(References(path,source))return new(false,"A registered installer still references this source.");}
  return new(true,"No reference found for CodeCang family in current-user and machine inventory; other users and unrelated products were not inspected.");
 }
 internal static MsiCleanupDecision Revalidate(string root,string relative,MsiPackageIdentity identity)=>Evaluate(StoragePinnedFile.Resolve(root,relative),identity,MsiQueryProductState(identity.ProductCode),ReadInventory(identity.ProductCode));
 internal static IDisposable AcquireKnownInstallerIdle(string[]? names=null){var owned=new List<Mutex>();try{foreach(string name in names??new[]{@"Global\_MSIExecute",@"Local\_MSIExecute"}){Mutex mutex;try{mutex=Mutex.OpenExisting(name);}catch(WaitHandleCannotBeOpenedException){continue;}bool acquired=false;try{try{acquired=mutex.WaitOne(0);}catch(AbandonedMutexException){acquired=true;}if(!acquired)throw new IOException("Windows Installer is executing; source retained.");owned.Add(mutex);}finally{if(!acquired)mutex.Dispose();}}return new InstallerLease(owned);}catch{foreach(var m in owned){m.ReleaseMutex();m.Dispose();}throw;}}
 sealed class InstallerLease(List<Mutex> owned):IDisposable{public void Dispose(){foreach(var m in owned){m.ReleaseMutex();m.Dispose();}}}
 internal static bool References(string candidate,string source){
  if(string.IsNullOrWhiteSpace(source))return false;
  string value=Environment.ExpandEnvironmentVariables(source.Trim());if(Regex.IsMatch(value,@"^[num];\d+;",RegexOptions.IgnoreCase))value=value[(value.IndexOf(';',2)+1)..];
  if(Uri.TryCreate(value,UriKind.Absolute,out var uri)&&!uri.IsFile)return false;
  if(uri?.IsFile==true)value=uri.LocalPath;
  if(!Path.IsPathFullyQualified(value))throw new IOException("Unresolved installer source.");
  string target=Path.GetFullPath(candidate).TrimEnd('\\'),reference=Path.GetFullPath(value).TrimEnd('\\');
  if(target.Equals(reference,StringComparison.OrdinalIgnoreCase)||target.StartsWith(reference+"\\",StringComparison.OrdinalIgnoreCase))return true;
  string? finalReference=CanonicalExisting(reference);if(finalReference==null)return false;string finalTarget=CanonicalExisting(target)??throw new IOException("Selected MSI disappeared");
  return finalTarget.Equals(finalReference,StringComparison.OrdinalIgnoreCase)||finalTarget.StartsWith(finalReference+"\\",StringComparison.OrdinalIgnoreCase);
 }
 static string? CanonicalExisting(string path){
  // Do not probe network sources (which could send credentials). Unknown network aliases stay protected.
  if(path.StartsWith("\\\\",StringComparison.Ordinal))throw new IOException("Network source identity cannot be verified locally");
  string root=Path.GetPathRoot(path)??throw new IOException("Missing local root");
  if(root.Length!=3||root[1]!=':'||GetDriveTypeW(root)!=3)throw new IOException("Not a fixed local drive source");
  var pinned=new List<SafeFileHandle>();try{
   string current=root;var components=new List<string>{root};foreach(string part in path[root.Length..].Split('\\',StringSplitOptions.RemoveEmptyEntries)){current=Path.Combine(current,part);components.Add(current);}
   foreach(string component in components){
    var item=CreateFileW(@"\\?\"+component,0x80,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    if(item.IsInvalid){int error=Marshal.GetLastWin32Error();item.Dispose();if(error is 2 or 3)return null;throw new System.ComponentModel.Win32Exception(error);}pinned.Add(item);
    if(!GetFileInformationByHandleEx(item,9,out var info,8))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    if((info.Attributes&0x400)!=0)throw new IOException("Reparse installer source cannot be verified locally");
   }
   var text=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(pinned[^1],text,(uint)text.Capacity,0);if(n==0||n>=text.Capacity)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());string result=text.ToString();if(result.StartsWith(@"\\?\",StringComparison.Ordinal))result=result[4..];return result.TrimEnd('\\');
  }finally{foreach(var handle in pinned)handle.Dispose();}
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern uint GetDriveTypeW(string root);
 [StructLayout(LayoutKind.Sequential)]struct AttributeTagInfo{public uint Attributes;public uint Tag;}
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int infoClass,out AttributeTagInfo info,uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern uint GetFinalPathNameByHandleW(SafeFileHandle file,StringBuilder path,uint size,uint flags);
 sealed class MsiReadException(uint code,string operation=""):IOException("Windows Installer "+operation+" read error "+code){internal uint Code=>code;}
 static void CheckCode(uint code,string operation=""){if(code!=0)throw new MsiReadException(code,operation);}
 static MsiPackageIdentity ReadPackage(string path){uint db=0;try{CheckCode(MsiOpenDatabase(path,IntPtr.Zero,out db));return new(Property(db,"ProductCode"),Property(db,"UpgradeCode"),Property(db,"ProductVersion"),PackageCode(db));}finally{if(db!=0)MsiCloseHandle(db);}}
 static string PackageCode(uint database){uint summary=0;try{CheckCode(MsiGetSummaryInformation(database,null,0,out summary),"PackageSummary");var text=new StringBuilder(1024);uint length=1024,type;int number;CheckCode(MsiSummaryInfoGetProperty(summary,9,out type,out number,IntPtr.Zero,text,ref length),"PackageCode");if(!Guid.TryParse(text.ToString(),out var package))throw new IOException("Invalid package code");return package.ToString("B");}finally{if(summary!=0)MsiCloseHandle(summary);}}
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiGetSummaryInformation(uint database,string? path,uint count,out uint summary);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiSummaryInfoGetProperty(uint summary,uint property,out uint type,out int number,IntPtr filetime,StringBuilder text,ref uint length);
 static string Property(uint database,string property){uint view=0,row=0;try{CheckCode(MsiDatabaseOpenView(database,"SELECT `Value` FROM `Property` WHERE `Property`='"+property+"'",out view));CheckCode(MsiViewExecute(view,0));CheckCode(MsiViewFetch(view,out row));var s=new StringBuilder(1024);uint n=1024;CheckCode(MsiRecordGetString(row,1,s,ref n));if(s.Length==0)throw new IOException("Missing package identity");return s.ToString();}finally{if(row!=0)MsiCloseHandle(row);if(view!=0)MsiCloseHandle(view);}}
 internal static MsiRegistrationInventory ReadInventory(string? candidateProduct=null){var products=new List<string>();var sources=new List<string>();try{
  var family=new HashSet<string>(StringComparer.OrdinalIgnoreCase);if(candidateProduct!=null)family.Add(candidateProduct);for(uint n=0;n<10000;n++){var related=new StringBuilder(39);uint result=MsiEnumRelatedProducts(UpgradeCode,0,n,related);if(result==259)break;CheckCode(result,"RelatedProducts");if(n==9999)throw new IOException("Related product limit exceeded");family.Add(related.ToString());}

  // Explicit user scope: current Windows user and machine only; no other-user claim.
  foreach(string familyProduct in family)foreach(uint scope in new uint[]{3,4})for(uint index=0;index<10000;index++){
   var product=new StringBuilder(39);var sid=new StringBuilder(256);uint size=256,context;uint code=MsiEnumProductsEx(familyProduct,null,scope,index,product,out context,sid,ref size);if(code==259)break;CheckCode(code);if(index==9999)throw new IOException("Installer inventory limit exceeded");products.Add(product.ToString());string? user=context==4?null:sid.ToString();
   foreach(string prop in new[]{"LocalPackage","InstallSource"}){var text=new StringBuilder(32768);uint length=32768;CheckCode(MsiGetProductInfoEx(product.ToString(),user,context,prop,text,ref length),"ProductInfo:"+prop+" context="+context+" sidEmpty="+string.IsNullOrEmpty(user)+" product="+product);if(text.Length>0)sources.Add(text.ToString());}
   AddLastSource(product.ToString(),user,context,0,sources);
   foreach(uint kind in new uint[]{1,2})for(uint n=0;n<10000;n++){var source=new StringBuilder(32768);uint length=32768;code=MsiSourceListEnumSources(product.ToString(),user,context,kind,n,source,ref length);if(code==259)break;CheckCode(code);if(n==9999)throw new IOException("Installer source limit exceeded");sources.Add(source.ToString());}
  }
  // Patches can carry registered source locations too; denied/incomplete patch scope is unknown.
  foreach(string familyProduct in family)foreach(uint scope in new uint[]{3,4})for(uint index=0;index<10000;index++){
   var patch=new StringBuilder(39);var product=new StringBuilder(39);var sid=new StringBuilder(256);uint size=256,context;uint code=MsiEnumPatchesEx(familyProduct,null,scope,15,index,patch,product,out context,sid,ref size);if(code==259)break;CheckCode(code);if(index==9999)throw new IOException("Patch inventory limit exceeded");string? user=context==4?null:sid.ToString();var local=new StringBuilder(32768);uint localLength=32768;CheckCode(MsiGetPatchInfoEx(patch.ToString(),product.ToString(),user,context,"LocalPackage",local,ref localLength));if(local.Length>0)sources.Add(local.ToString());
   AddLastSource(patch.ToString(),user,context,0x40000000,sources);
   foreach(uint kind in new uint[]{1,2})for(uint n=0;n<10000;n++){var source=new StringBuilder(32768);uint length=32768;code=MsiSourceListEnumSources(patch.ToString(),user,context,0x40000000|kind,n,source,ref length);if(code==259)break;CheckCode(code);if(n==9999)throw new IOException("Patch source limit exceeded");sources.Add(source.ToString());}
  }
  return new(true,products,sources);
 }catch(Exception e){return new(false,products,sources,e is MsiReadException denied&&denied.Code==5?"当前权限无法完成当前用户及机器级安装源核验，已保留。":"Windows Installer 当前用户及机器级核验未完成，已保留（"+e.Message+"）。",e is MsiReadException native?native.Code:null);}}
 static void AddLastSource(string code,string? sid,uint context,uint options,List<string> sources){var text=new StringBuilder(32768);uint length=32768;CheckCode(MsiSourceListGetInfo(code,sid,context,options,"LastUsedSource",text,ref length),"LastUsedSource");if(text.Length>0)sources.Add(text.ToString());}
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiEnumRelatedProducts(string upgrade,uint reserved,uint index,StringBuilder product);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiSourceListGetInfo(string code,string? sid,uint context,uint options,string property,StringBuilder value,ref uint length);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiOpenDatabase(string file,IntPtr persist,out uint database);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiDatabaseOpenView(uint database,string query,out uint view);
 [DllImport("msi.dll")]static extern uint MsiViewExecute(uint view,uint record);
 [DllImport("msi.dll")]static extern uint MsiViewFetch(uint view,out uint record);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiRecordGetString(uint record,uint field,StringBuilder value,ref uint length);
 [DllImport("msi.dll")]static extern uint MsiCloseHandle(uint handle);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern int MsiQueryProductState(string productCode);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiEnumProductsEx(string? product,string? sid,uint context,uint index,StringBuilder installedProduct,out uint installedContext,StringBuilder installedSid,ref uint sidLength);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiGetProductInfoEx(string product,string? sid,uint context,string property,StringBuilder value,ref uint length);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiEnumPatchesEx(string? product,string? sid,uint context,uint filter,uint index,StringBuilder patch,StringBuilder targetProduct,out uint targetContext,StringBuilder targetSid,ref uint sidLength);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiGetPatchInfoEx(string patch,string product,string? sid,uint context,string property,StringBuilder value,ref uint length);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiSourceListEnumSources(string product,string? sid,uint context,uint options,uint index,StringBuilder value,ref uint length);
}




