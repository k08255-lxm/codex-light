using System.Text.Json;
namespace CodexLight.Desktop;
internal static class CloseBehaviorBridge {
 internal static bool IsMessage(string json){if(json.Length>4096)return false;try{using var doc=JsonDocument.Parse(json);return doc.RootElement.ValueKind==JsonValueKind.Object&&doc.RootElement.TryGetProperty("type",out var type)&&type.ValueKind==JsonValueKind.String&&type.GetString()=="desktopCloseBehavior";}catch(JsonException){return false;}}
 internal static (string Id,string Operation,CloseBehavior Behavior) Read(string json,string nonce){
  if(json.Length>4096)throw new InvalidDataException();using var doc=JsonDocument.Parse(json);var v=doc.RootElement;
  string? id=v.GetProperty("id").GetString(),op=v.GetProperty("operation").GetString();
  if(v.GetProperty("type").GetString()!="desktopCloseBehavior"||v.GetProperty("nonce").GetString()!=nonce||id==null||id.Length is <1 or >32||!id.All(char.IsAsciiDigit)||op is not ("get" or "set")||v.EnumerateObject().Count()!=(op=="set"?5:4))throw new InvalidDataException();
  return(id,op,op=="set"?CloseBehaviorStore.Parse(v.GetProperty("behavior").GetString()):CloseBehavior.Ask);
 }
 internal static string Script(string nonce)=>"""
 (()=>{if(window!==window.top)return;const nonce=NONCE, pending=new Map();let sequence=0;
 const request=(operation,behavior)=>new Promise((resolve,reject)=>{if(pending.size>8){reject(new Error('请求过多'));return;}const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(new Error('桌面没有响应，请重试'));},5000);pending.set(id,{resolve,reject,timer});window.chrome.webview.postMessage({type:'desktopCloseBehavior',nonce,id,operation,...(operation==='set'?{behavior}:{})});});
 window.chrome.webview.addEventListener('message',event=>{const v=event.data;if(v?.type==='desktopCloseBehaviorChanged'){window.dispatchEvent(new CustomEvent('desktop-close-behavior-changed',{detail:v.behavior}));return;}if(v?.type!=='desktopCloseBehaviorResult')return;const p=pending.get(v.id);if(!p)return;pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(new Error(v.error)):p.resolve({behavior:v.behavior,warning:v.warning});});
 Object.defineProperty(window,'codexLightCloseBehavior',{value:Object.freeze({get:()=>request('get'),set:behavior=>request('set',behavior)}),writable:false,configurable:false});})();
 """.Replace("NONCE",JsonSerializer.Serialize(nonce));
}
