using System.Runtime.InteropServices;

namespace CodexLight.Desktop;

// The execution state belongs to the calling thread. The host changes and
// releases it on its WinForms thread, including when the window is in the tray.
internal sealed class SystemSleepRequest {
 const uint Continuous=0x80000000, SystemRequired=0x00000001;
 [DllImport("kernel32.dll")]
 static extern uint SetThreadExecutionState(uint flags);

 bool active;
 internal bool Set(bool keepAwake){
  if(active==keepAwake)return true;
  if(SetThreadExecutionState(Continuous|(keepAwake?SystemRequired:0))==0)return false;
  active=keepAwake;
  return true;
 }
}
