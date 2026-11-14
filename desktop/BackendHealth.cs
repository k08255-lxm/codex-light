using System.Diagnostics;
using System.Text.Json;
namespace CodexLight.Desktop;
// Component health only, before UI/single-instance initialization.
internal static class BackendHealth {
 internal static async Task<int> RunAsync(){
  try{
   var webViewVersion=Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString();
   if(string.IsNullOrWhiteSpace(webViewVersion)||!Version.TryParse(webViewVersion.Split(' ',StringSplitOptions.RemoveEmptyEntries)[0],out _))throw new InvalidOperationException();
   string root=Path.Combine(AppContext.BaseDirectory,"app"),script=Path.Combine(root,"src","backend-health.mjs");
   if(!File.Exists(script))throw new FileNotFoundException();
   var runtime=CodexLight.Runtime.NodeRuntimeDetection.FindCompatible(AppContext.BaseDirectory);
   if(runtime==null)throw new InvalidOperationException();
   var start=new ProcessStartInfo(runtime.Path){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=root};
   start.ArgumentList.Add(script);start.Environment.Remove("NODE_OPTIONS");start.Environment.Remove("NODE_PATH");
   using var child=Process.Start(start)??throw new InvalidOperationException();
   var output=child.StandardOutput.ReadToEndAsync();var errors=child.StandardError.ReadToEndAsync();
   try{await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(35));}
   catch(TimeoutException){if(!child.HasExited)child.Kill(false);throw;}
   var text=await output;await errors;
   if(child.ExitCode!=0||text.Length>4096)throw new InvalidOperationException();
   using var result=JsonDocument.Parse(text);var r=result.RootElement;
   var expectedVersion=typeof(BackendHealth).Assembly.GetName().Version?.ToString(3)??throw new InvalidOperationException();
   if(!r.GetProperty("ok").GetBoolean()||r.GetProperty("scope").GetString()!="isolated-demo-backend"||r.GetProperty("realAccountVerified").GetBoolean()||!r.GetProperty("gracefulShutdown").GetBoolean()||!r.GetProperty("authenticatedStatus").GetBoolean()||!r.GetProperty("unauthenticatedRejected").GetBoolean()||!r.GetProperty("loopbackOnly").GetBoolean()||r.GetProperty("version").GetString()!=expectedVersion)throw new InvalidOperationException();
   Console.WriteLine(JsonSerializer.Serialize(new{ok=true,scope="native-and-isolated-demo-backend",webViewVersion,dotnetVersion=Environment.Version.ToString(),nativeVersion=typeof(BackendHealth).Assembly.GetName().Version?.ToString(),backendVersion=r.GetProperty("version").GetString(),nodeVersion=r.GetProperty("nodeVersion").GetString(),authenticatedStatus=r.GetProperty("authenticatedStatus").GetBoolean(),unauthenticatedRejected=r.GetProperty("unauthenticatedRejected").GetBoolean(),loopbackOnly=r.GetProperty("loopbackOnly").GetBoolean(),gracefulShutdown=true,realAccountVerified=false}));
   return 0;
  }catch{Console.WriteLine("{\"ok\":false,\"scope\":\"native-and-isolated-demo-backend\",\"code\":\"NATIVE_BACKEND_HEALTH_FAILED\"}");return 1;}
 }
}
