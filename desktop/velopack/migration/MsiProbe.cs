using System.Runtime.InteropServices;
using System.Text;
namespace CodexLight.Migration;
public static class MsiProbe {
 static string Info(string product,string property){uint n=32767;var s=new StringBuilder((int)n);Check(MsiGetProductInfoEx(product,null,2,property,s,ref n));return s.ToString();}
 static void Check(uint code){if(code!=0)throw new InvalidOperationException("MSI read failed: "+code);}
 static string Field(uint database,string name){uint view=0,record=0;try{Check(MsiDatabaseOpenView(database,"SELECT `Value` FROM `Property` WHERE `Property`='"+name+"'",out view));Check(MsiViewExecute(view,0));Check(MsiViewFetch(view,out record));uint n=32767;var text=new StringBuilder((int)n);Check(MsiRecordGetString(record,1,text,ref n));return text.ToString();}finally{if(record!=0)MsiCloseHandle(record);if(view!=0)MsiCloseHandle(view);}}
 public static LegacyInstall ReadCurrentUser() {
  var product=new StringBuilder(39);Check(MsiEnumRelatedProducts(MigrationCoordinator.UpgradeCode,0,0,product));
  if(MsiEnumRelatedProducts(MigrationCoordinator.UpgradeCode,0,1,new StringBuilder(39))!=259)throw new InvalidOperationException("More than one related MSI or enumeration failed.");
  var code=product.ToString();var version=Info(code,"VersionString");var root=Info(code,"InstallLocation");var source=Info(code,"InstallSource");
  uint n=32767;var name=new StringBuilder((int)n);Check(MsiSourceListGetInfo(code,null,2,0,"PackageName",name,ref n));
  if(string.IsNullOrWhiteSpace(source)||!Path.IsPathFullyQualified(source)||Path.GetFileName(name.ToString())!=name.ToString()||!name.ToString().EndsWith(".msi",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("MSI source unavailable or malformed.");
  string file=Path.Combine(source,name.ToString());uint database=0;
  try{Check(MsiOpenDatabase(file,IntPtr.Zero,out database));if(!Field(database,"ProductCode").Equals(code,StringComparison.OrdinalIgnoreCase)||!Field(database,"UpgradeCode").Equals(MigrationCoordinator.UpgradeCode,StringComparison.OrdinalIgnoreCase)||Field(database,"ProductVersion")!=version)throw new InvalidOperationException("Registered source belongs to another product/version.");}
  finally{if(database!=0)MsiCloseHandle(database);}
  return new LegacyInstall(code,MigrationCoordinator.UpgradeCode,version,root,file,MigrationCoordinator.Hash(file));
 }
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiEnumRelatedProducts(string code,int reserved,int index,StringBuilder product);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiGetProductInfoEx(string code,string? sid,uint context,string property,StringBuilder value,ref uint length);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiSourceListGetInfo(string code,string? sid,uint context,uint options,string property,StringBuilder value,ref uint length);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiOpenDatabase(string file,IntPtr persist,out uint database);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiDatabaseOpenView(uint database,string query,out uint view);
 [DllImport("msi.dll")]static extern uint MsiViewExecute(uint view,uint record);
 [DllImport("msi.dll")]static extern uint MsiViewFetch(uint view,out uint record);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)]static extern uint MsiRecordGetString(uint record,uint field,StringBuilder value,ref uint length);
 [DllImport("msi.dll")]static extern uint MsiCloseHandle(uint handle);
}
