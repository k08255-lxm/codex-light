using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace CodexLight.Desktop;

// Reuses the existing tray icon. No commands, question contents or answers cross this bridge.
internal sealed class QuestionNotificationBridge : IDisposable {
 readonly Form owner; readonly CoreWebView2 core; readonly Func<NotifyIcon> getTray; readonly Action restore;
 readonly string nonce=Guid.NewGuid().ToString("N");
 readonly Dictionary<string,QuestionNotice> pending=new();
 NotifyIcon? boundTray;
 internal QuestionNotificationBridge(Form owner,CoreWebView2 core,Func<NotifyIcon> getTray,Action restore){this.owner=owner;this.core=core;this.getTray=getTray;this.restore=restore;owner.Activated+=Activated;}
 internal sealed record QuestionNotice(string Id,string ThreadId,string Kind);
 internal sealed record Request(string Sequence,string Operation,QuestionNotice Notice);
 internal static Request Read(string json,string nonce){
  if(json.Length>4096)throw new InvalidDataException();
  using var doc=JsonDocument.Parse(json);var v=doc.RootElement;
  if(v.ValueKind!=JsonValueKind.Object||v.GetProperty("type").GetString()!="desktopQuestionNotification"||v.GetProperty("nonce").GetString()!=nonce)throw new InvalidDataException();
  string sequence=v.GetProperty("sequence").GetString()??"",operation=v.GetProperty("operation").GetString()??"";
  if(sequence.Length is <1 or >32||!sequence.All(char.IsAsciiDigit)||operation is not ("show" or "clear" or "clearAll"))throw new InvalidDataException();
  int fields=operation=="show"?7:operation=="clear"?5:4;
  if(v.EnumerateObject().Count()!=fields)throw new InvalidDataException();
  string id=operation=="clearAll"?"":v.GetProperty("id").GetString()??"";
  if(operation!="clearAll"&&(id.Length is <1 or >80||id.Any(c=>!char.IsAsciiLetterOrDigit(c)&&c!='-'&&c!='_')))throw new InvalidDataException();
  string thread=operation=="show"?v.GetProperty("threadId").GetString()??"":"",kind=operation=="show"?v.GetProperty("kind").GetString()??"":"";
  if(operation=="show"&&(kind is not ("question" or "approval")||thread.Length>200||thread.Any(c=>!char.IsAsciiLetterOrDigit(c)&&c is not ('.' or '_' or ':' or '/' or '-'))))throw new InvalidDataException();
  return new(sequence,operation,new(id,thread,kind));
 }
 internal bool Handle(string json){
  try{using var doc=JsonDocument.Parse(json);if(doc.RootElement.ValueKind!=JsonValueKind.Object||!doc.RootElement.TryGetProperty("type",out var type)||type.ValueKind!=JsonValueKind.String||type.GetString()!="desktopQuestionNotification")return false;}
  catch(JsonException){return false;}
  string? sequence=null;
  try{
   var request=Read(json,nonce);sequence=request.Sequence;string status="cleared";
   if(request.Operation=="clearAll")pending.Clear();
   else if(request.Operation=="clear")pending.Remove(request.Notice.Id);
   else if(owner.Visible&&owner.WindowState!=FormWindowState.Minimized&&owner.ContainsFocus)status="foreground";
   else if(pending.ContainsKey(request.Notice.Id))status="duplicate";
   else{
    if(pending.Count>=128)throw new InvalidDataException("Too many pending reminders");
    var tray=getTray();if(boundTray!=tray){if(boundTray!=null)boundTray.BalloonTipClicked-=Clicked;boundTray=tray;tray.BalloonTipClicked+=Clicked;}
    pending.Add(request.Notice.Id,request.Notice);
    // Aggregate wording keeps the click target correct when Windows replaces a previous balloon.
    tray.ShowBalloonTip(10000,"码舱 CodeCang · 等待你处理",pending.Count==1?(request.Notice.Kind=="question"?"Codex 有问题等待你的回答。点击返回对话。":"Codex 有操作等待你的审批。点击返回对话。"):$"有 {pending.Count} 项回答或审批等待处理。点击查看。",ToolTipIcon.Info);
    Flash(true);status="requested";
   }
   if(pending.Count==0)Flash(false);
   core.PostWebMessageAsJson(JsonSerializer.Serialize(new{type="desktopQuestionNotificationResult",sequence,status}));
  }catch(Exception error)when(error is JsonException or InvalidDataException or InvalidOperationException or KeyNotFoundException or System.ComponentModel.Win32Exception){
   System.Diagnostics.Trace.WriteLine("Question notification request could not be completed.");
   if(sequence!=null)try{core.PostWebMessageAsJson(JsonSerializer.Serialize(new{type="desktopQuestionNotificationResult",sequence,error="系统提醒暂时不可用"}));}catch(InvalidOperationException){}
  }
  return true;
 }
 void Clicked(object? sender,EventArgs args){
  if(owner.IsDisposed)return;var notice=pending.Values.FirstOrDefault();restore();Flash(false);
  if(notice!=null)try{core.PostWebMessageAsJson(JsonSerializer.Serialize(new{type="desktopQuestionNotificationOpen",id=notice.Id,threadId=notice.ThreadId}));}catch(InvalidOperationException){}
 }
 void Activated(object? sender,EventArgs args)=>Flash(false);
 void Flash(bool value){if(!owner.IsHandleCreated)return;var info=new FlashInfo{Size=(uint)Marshal.SizeOf<FlashInfo>(),Window=owner.Handle,Flags=value?2u:0u,Count=value?3u:0u};FlashWindowEx(ref info);}
 [StructLayout(LayoutKind.Sequential)]struct FlashInfo{internal uint Size;internal IntPtr Window;internal uint Flags;internal uint Count;internal uint Timeout;}
 [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]static extern bool FlashWindowEx(ref FlashInfo info);
 public void Dispose(){owner.Activated-=Activated;if(boundTray!=null)boundTray.BalloonTipClicked-=Clicked;pending.Clear();Flash(false);}
 internal string Script=>"""
 (()=>{if(window!==window.top)return;const nonce=NONCE,pending=new Map();let sequence=0;
 const request=(operation,data={})=>new Promise((resolve,reject)=>{if(pending.size>=128){reject(new Error('提醒请求过多'));return;}const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(new Error('桌面提醒没有响应'));},5000);pending.set(id,{resolve,reject,timer});window.chrome.webview.postMessage({type:'desktopQuestionNotification',nonce,sequence:id,operation,...data});});
 window.chrome.webview.addEventListener('message',event=>{const v=event.data;if(v?.type==='desktopQuestionNotificationOpen'){window.dispatchEvent(new CustomEvent('codex-light-question-open',{detail:{id:v.id,threadId:v.threadId}}));return;}if(v?.type!=='desktopQuestionNotificationResult')return;const p=pending.get(v.sequence);if(!p)return;pending.delete(v.sequence);clearTimeout(p.timer);v.error?p.reject(new Error(v.error)):p.resolve({status:v.status});});
 Object.defineProperty(window,'codexLightQuestionNotifications',{value:Object.freeze({show:data=>request('show',data),clear:id=>request('clear',{id}),clearAll:()=>request('clearAll')}),writable:false,configurable:false});})();
 """.Replace("NONCE",JsonSerializer.Serialize(nonce));
}
