using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Toolkit.Uwp.Notifications;
using Microsoft.Web.WebView2.Core;
using Windows.UI.Notifications;

namespace CodexLight.Desktop;

// Only opaque activation arguments reach Windows. Request identity stays in the live WebView session.
internal sealed class QuestionNotificationBridge : IDisposable {
 const string Group="codex-questions";
 readonly Form owner; readonly CoreWebView2 core; readonly Action restore;
 readonly string nonce=Guid.NewGuid().ToString("N");
 readonly Dictionary<string,ActiveToast> pending=new();
 bool initialized, disposed;
 internal QuestionNotificationBridge(Form owner,CoreWebView2 core,Action restore){this.owner=owner;this.core=core;this.restore=restore;}
 internal sealed record QuestionNotice(string Id,string ThreadId,string Kind);
 internal sealed record Request(string Sequence,string Operation,QuestionNotice Notice);
 sealed record ActiveToast(QuestionNotice Notice,string Token,DateTimeOffset Expires){
  internal string Tag=>Token[..16];
 }
 internal static Request Read(string json,string nonce){
  if(json.Length>4096)throw new InvalidDataException();
  using var doc=JsonDocument.Parse(json);var v=doc.RootElement;
  if(v.ValueKind!=JsonValueKind.Object||v.GetProperty("type").GetString()!="desktopQuestionNotification"||v.GetProperty("nonce").GetString()!=nonce)throw new InvalidDataException();
  string sequence=v.GetProperty("sequence").GetString()??"",operation=v.GetProperty("operation").GetString()??"";
  if(sequence.Length is <1 or >32||!sequence.All(char.IsAsciiDigit)||operation is not ("show" or "clear" or "clearAll" or "status" or "openSettings"))throw new InvalidDataException();
  int fields=operation=="show"?7:operation=="clear"?5:4;
  if(v.EnumerateObject().Count()!=fields)throw new InvalidDataException();
  string id=fields==4?"":v.GetProperty("id").GetString()??"";
  if(fields!=4&&!System.Text.RegularExpressions.Regex.IsMatch(id,@"\A(?:question-[0-9]{1,10}|request-[a-f0-9]{16}|async-[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}\|[A-Za-z0-9][A-Za-z0-9._:/-]{0,199})\z"))throw new InvalidDataException();
  string thread=operation=="show"?v.GetProperty("threadId").GetString()??"":"",kind=operation=="show"?v.GetProperty("kind").GetString()??"":"";
  if(operation=="show"&&(kind is not ("question" or "approval")||thread.Length>200||
   (thread.Length>0&&!char.IsAsciiLetterOrDigit(thread[0]))||thread.Any(c=>!char.IsAsciiLetterOrDigit(c)&&c is not ('.' or '_' or ':' or '/' or '-'))))throw new InvalidDataException();
  return new(sequence,operation,new(id,thread,kind));
 }
 internal bool Handle(string json){
  try{using var doc=JsonDocument.Parse(json);if(doc.RootElement.ValueKind!=JsonValueKind.Object||!doc.RootElement.TryGetProperty("type",out var type)||type.ValueKind!=JsonValueKind.String||type.GetString()!="desktopQuestionNotification")return false;}
  catch(JsonException){return false;}
  string? sequence=null;
  try{
   var request=Read(json,nonce);sequence=request.Sequence;string status="cleared";
   if(request.Operation=="status")status=ToastNotificationManagerCompat.CreateToastNotifier().Setting==NotificationSetting.Enabled?"ready":"blocked";
   else if(request.Operation=="openSettings"){
    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("ms-settings:notifications"){UseShellExecute=true});
    status="opened";
   }
   else if(request.Operation=="clearAll")ClearAll();
   else if(request.Operation=="clear")Clear(request.Notice.Id);
   else status=Show(request.Notice);
   core.PostWebMessageAsJson(JsonSerializer.Serialize(new{type="desktopQuestionNotificationResult",sequence,status}));
  }catch(Exception error)when(error is JsonException or InvalidDataException or InvalidOperationException or KeyNotFoundException or ArgumentException || NotificationFailure(error)){
   System.Diagnostics.Trace.WriteLine("Question notification request could not be completed.");
   if(sequence!=null)try{core.PostWebMessageAsJson(JsonSerializer.Serialize(new{type="desktopQuestionNotificationResult",sequence,error="系统提醒暂时不可用"}));}catch(InvalidOperationException){}
  }
  return true;
 }
 internal static ToastContent BuildContent(string kind,string token)=>new ToastContentBuilder()
  .AddArgument("questionNotice",token)
  .AddText(kind=="question"?"Codex 等待你的回答":"Codex 等待你的审批")
  .AddText("打开通知，回到对应请求。")
  .GetToastContent();
 string Show(QuestionNotice notice){
  if(disposed)return "cleared";
  if(pending.ContainsKey(notice.Id))return "duplicate";
  var notifier=ToastNotificationManagerCompat.CreateToastNotifier();
  if(notifier.Setting!=NotificationSetting.Enabled)return "blocked";
  if(!initialized){
   ToastNotificationManagerCompat.OnActivated+=OnActivated;
   initialized=true;
   ToastNotificationManagerCompat.History.RemoveGroup(Group);
  }
  var now=DateTimeOffset.UtcNow;
  foreach(var expired in pending.Values.Where(entry=>entry.Expires<=now).ToArray())Clear(expired.Notice.Id);
  if(pending.Count>=128)throw new InvalidDataException("Too many pending reminders");
  var active=new ActiveToast(notice,Guid.NewGuid().ToString("N"),now.AddMinutes(15));
  var toast=new ToastNotification(BuildContent(notice.Kind,active.Token).GetXml()){
   Tag=active.Tag,Group=Group,ExpirationTime=active.Expires
  };
  notifier.Show(toast);
  pending.Add(notice.Id,active);
  return "requested";
 }
 static bool NotificationFailure(Exception error)=>error is COMException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or TypeLoadException or System.Security.SecurityException;
 void Clear(string id){
  if(pending.Remove(id,out var toast))ToastNotificationManagerCompat.History.Remove(toast.Tag,Group);
 }
 internal void ClearAll(){
  pending.Clear();
  if(!initialized)return;
  try{ToastNotificationManagerCompat.History.RemoveGroup(Group);}
  catch(Exception error)when(error is InvalidOperationException||NotificationFailure(error)){System.Diagnostics.Trace.WriteLine("Question notifications could not be removed.");}
 }
 void OnActivated(ToastNotificationActivatedEventArgsCompat args){
  const string key="questionNotice=";
  string argument=args.Argument;
  if(!argument.StartsWith(key,StringComparison.Ordinal)||!Guid.TryParseExact(argument[key.Length..],"N",out _))return;
  try{owner.BeginInvoke((Action)(()=>{
   if(disposed||owner.IsDisposed)return;
   var toast=pending.Values.FirstOrDefault(entry=>entry.Token==argument[key.Length..]&&entry.Expires>DateTimeOffset.UtcNow);
   if(toast==null)return;
   try{Clear(toast.Notice.Id);}
   catch(Exception error)when(error is InvalidOperationException||NotificationFailure(error)){System.Diagnostics.Trace.WriteLine("Question notification could not be removed.");}
   restore();
   var notice=toast.Notice;
   try{core.PostWebMessageAsJson(JsonSerializer.Serialize(new{type="desktopQuestionNotificationOpen",id=notice.Id,threadId=notice.ThreadId}));}
   catch(InvalidOperationException){}
  }));}catch(InvalidOperationException){}
 }
 public void Dispose(){
  disposed=true;
  if(initialized)ToastNotificationManagerCompat.OnActivated-=OnActivated;
  ClearAll();
 }
 internal string Script=>"""
 (()=>{if(window!==window.top)return;const nonce=NONCE,pending=new Map();let sequence=0,status='checking';
 const request=(operation,data={})=>new Promise((resolve,reject)=>{if(pending.size>=128){reject(new Error('提醒请求过多'));return;}const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(new Error('桌面提醒没有响应'));},5000);pending.set(id,{resolve,reject,timer});window.chrome.webview.postMessage({type:'desktopQuestionNotification',nonce,sequence:id,operation,...data});});
 window.chrome.webview.addEventListener('message',event=>{const v=event.data;if(v?.type==='desktopQuestionNotificationOpen'){window.dispatchEvent(new CustomEvent('codex-light-question-open',{detail:{id:v.id,threadId:v.threadId}}));return;}if(v?.type!=='desktopQuestionNotificationResult')return;const p=pending.get(v.sequence);if(!p)return;pending.delete(v.sequence);clearTimeout(p.timer);v.error?p.reject(new Error(v.error)):p.resolve({status:v.status});
 if(['requested','ready','blocked'].includes(v.status)){status=v.status==='requested'?'ready':v.status;window.dispatchEvent(new Event('codexlight-question-notification-status'));}});
 Object.defineProperty(window,'codexLightQuestionNotifications',{value:Object.freeze({status:()=>status,refreshStatus:()=>request('status').catch(error=>{status='unavailable';throw error;}),openSettings:()=>request('openSettings'),show:data=>request('show',data),clear:id=>request('clear',{id}),clearAll:()=>request('clearAll')}),writable:false,configurable:false});})();
 """.Replace("NONCE",JsonSerializer.Serialize(nonce));
}
