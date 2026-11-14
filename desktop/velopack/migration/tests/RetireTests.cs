using CodexLight.Migration;
static class RetireTests {
 public static int Run(){
 var good="{\"ok\":true,\"scope\":\"native-and-isolated-demo-backend\",\"realAccountVerified\":false,\"gracefulShutdown\":true,\"backendVersion\":\"0.4.4\"}";
 SafeRetire.VerifyHealth(good,"0.4.4");
 foreach(var bad in new[]{good.Replace("0.4.4","0.4.3"),good.Replace("\"ok\":true","\"ok\":false"),good.Replace("\"realAccountVerified\":false","\"realAccountVerified\":true"),good.Replace("\"gracefulShutdown\":true","\"gracefulShutdown\":false"),good.Replace("native-and-isolated-demo-backend","unknown")}){bool failed=false;try{SafeRetire.VerifyHealth(bad,"0.4.4");}catch(System.IO.IOException){failed=true;}if(!failed)throw new Exception("Automated retirement accepted invalid health");}
 Console.WriteLine("PASS 6 automated retirement health evidence checks");
int count=0;var now=DateTime.UtcNow;var e=new GuiObservation("receipt","manifest","exe",123,now.AddMinutes(-5),now,true,true);SafeRetire.ValidateObservation(e,"receipt","manifest","exe");count++;
 foreach(var bad in new[]{e with{ReceiptSha256="other"},e with{ManifestSha256="other"},e with{ExeSha256="other"},e with{WindowResponding=false},e with{UserConfirmedRealUse=false},e with{StartUtc=now.AddMinutes(2)},e with{ProcessId=0}}){bool rejected=false;try{SafeRetire.ValidateObservation(bad,"receipt","manifest","exe");}catch(IOException){rejected=true;}if(!rejected)throw new Exception("Unsafe GUI proof accepted");count++;}
 Console.WriteLine($"PASS {count} retirement GUI evidence guards; no real registry or app access.");return count;}
}
