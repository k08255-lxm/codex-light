namespace CodexLight.Desktop;

// WM_QUERYENDSESSION is a vote, not a commitment: another application or the
// user can still cancel. Only WM_ENDSESSION(TRUE) commits session termination.
internal sealed class WindowSessionEnd {
 internal bool QueryPending{get;private set;}
 internal bool Confirmed{get;private set;}
 internal void Observe(int message,IntPtr wParam){
  if(message==0x0011){QueryPending=true;Confirmed=false;}
  if(message==0x0016){QueryPending=false;Confirmed=wParam!=IntPtr.Zero;}
 }
 internal bool DeferCleanup(CloseReason reason)=>QueryPending||reason==CloseReason.WindowsShutDown;
}
