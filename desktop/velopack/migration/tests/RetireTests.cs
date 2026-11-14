using CodexLight.Migration;
static class RetireTests {
 public static int Run(){int count=0;var now=DateTime.UtcNow;var e=new GuiObservation("receipt","manifest","exe",123,now.AddMinutes(-5),now,true,true);SafeRetire.ValidateObservation(e,"receipt","manifest","exe");count++;
 foreach(var bad in new[]{e with{ReceiptSha256="other"},e with{ManifestSha256="other"},e with{ExeSha256="other"},e with{WindowResponding=false},e with{UserConfirmedRealUse=false},e with{StartUtc=now.AddMinutes(2)},e with{ProcessId=0}}){bool rejected=false;try{SafeRetire.ValidateObservation(bad,"receipt","manifest","exe");}catch(IOException){rejected=true;}if(!rejected)throw new Exception("Unsafe GUI proof accepted");count++;}
 Console.WriteLine($"PASS {count} retirement GUI evidence guards; no real registry or app access.");return count;}
}
