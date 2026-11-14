using System;
using System.IO;
namespace CodexLight.PublicSetup {
 internal enum Route { Fresh, Migrate, Velopack, Blocked }
 internal static class Routing {
  internal static string ValidateLegacyRoot(string location,Func<string,bool> directoryExists,Func<string,bool> fileExists){
   if(string.IsNullOrWhiteSpace(location)||location.Length<3||!char.IsLetter(location[0])||location[1]!=':'||(location[2]!='\\'&&location[2]!='/'))throw new IOException("Invalid MSI InstallLocation");
   string root=Path.GetFullPath(location).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar);
   if(root.Length<=3||!directoryExists(root)||!fileExists(Path.Combine(root,"CodexLight.exe")))throw new IOException("MSI installation root or executable missing");
   return root;
  }
  internal static Route Choose(int msiCount,bool oldRoot,bool newRoot,bool veloRegistration,bool unknownRegistration,bool dataOnly) {
   if(msiCount<0||msiCount>1||unknownRegistration)return Route.Blocked;
   if(msiCount==1)return oldRoot&&!newRoot&&!veloRegistration?Route.Migrate:Route.Blocked;
   if(oldRoot)return Route.Blocked;
   if(newRoot||veloRegistration)return newRoot&&veloRegistration?Route.Velopack:Route.Blocked;
   return dataOnly?Route.Blocked:Route.Fresh;
  }
 }
}
