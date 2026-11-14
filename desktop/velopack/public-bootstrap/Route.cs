using System;
namespace CodexLight.PublicSetup {
 internal enum Route { Fresh, Migrate, Velopack, Blocked }
 internal static class Routing {
  internal static Route Choose(int msiCount,bool oldRoot,bool newRoot,bool veloRegistration,bool unknownRegistration,bool dataOnly) {
   if(msiCount<0||msiCount>1||unknownRegistration)return Route.Blocked;
   if(msiCount==1)return oldRoot&&!newRoot&&!veloRegistration?Route.Migrate:Route.Blocked;
   if(oldRoot)return Route.Blocked;
   if(newRoot||veloRegistration)return newRoot&&veloRegistration?Route.Velopack:Route.Blocked;
   return dataOnly?Route.Blocked:Route.Fresh;
  }
 }
}
