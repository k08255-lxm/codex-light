using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Toolkit.Uwp.Notifications;
using Windows.UI.Notifications;

namespace CodexLight.Desktop;

// Only opaque activation arguments reach Windows. Request identity stays in the live WebView session.
internal sealed class QuestionNotificationBridge : IDisposable {
 const string Group="codex-questions";
 readonly Form owner; readonly Action<string> postMessage; readonly Action restore; readonly Func<string> readPermission;
 readonly string nonce=Guid.NewGuid().ToString("N");
 readonly Dictionary<string,ActiveToast> pending=new();
 // The Windows notification service can stall even while reading its settings.
 // Keep its calls and the pending toast table on one ordered background queue.
 Task tail=Task.CompletedTask;
 Task<string>? permissionQuery;
 volatile int documentGeneration;
 int outstanding;
 bool initialized;
 volatile bool disposed;
 internal QuestionNotificationBridge(Form owner,Action<string> postMessage,Action restore,Func<string>? readPermission=null){
  this.owner=owner;this.postMessage=postMessage;this.restore=restore;this.readPermission=readPermission??ReadPermission;
 }
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
  try{
   var request=Read(json,nonce);
   if(!disposed)_=ReplyAsync(request,documentGeneration);
  }catch(Exception error)when(error is JsonException or InvalidDataException or InvalidOperationException or KeyNotFoundException or ArgumentException){
   System.Diagnostics.Trace.WriteLine("Invalid question notification request.");
  }
  return true;
 }
 // Only the WinForms thread appends work. Never wait for the tail on that thread.
 Task<T> Enqueue<T>(Func<T> action){
  var next=tail.ContinueWith(_=>action(),CancellationToken.None,TaskContinuationOptions.None,TaskScheduler.Default);
  tail=next;
  return next;
 }
 async Task ReplyAsync(Request request,int generation){
  string? status=null,failure=null;
  if(outstanding>=128)failure="提醒请求过多";
  else{
   outstanding++;
   try{
    if(request.Operation=="status"){
     if(permissionQuery==null||permissionQuery.IsCompleted)permissionQuery=Enqueue(readPermission);
     status=await permissionQuery;
    }else status=await Enqueue(()=>disposed||generation!=documentGeneration?"cleared":Execute(request));
   }catch(Exception error)when(error is InvalidDataException or InvalidOperationException or ArgumentException || NotificationFailure(error)){
    System.Diagnostics.Trace.WriteLine($"Windows notification service unavailable: 0x{error.HResult:X8}");
    failure="系统提醒暂时不可用";
   }finally{outstanding--;}
  }
  if(disposed||generation!=documentGeneration)return;
  try{postMessage(JsonSerializer.Serialize(new{type="desktopQuestionNotificationResult",sequence=request.Sequence,status,error=failure}));}
  catch(Exception error)when(error is InvalidOperationException or COMException){System.Diagnostics.Trace.WriteLine("Notification reply target unavailable.");}
 }
 static string ReadPermission()=>ToastNotificationManagerCompat.CreateToastNotifier().Setting==NotificationSetting.Enabled?"ready":"blocked";
 string Execute(Request request){
  switch(request.Operation){
   case "openSettings":
    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("ms-settings:notifications"){UseShellExecute=true})?.Dispose();
    return "opened";
   case "clearAll":ClearToasts();return "cleared";
   case "clear":Clear(request.Notice.Id);return "cleared";
   case "show":return Show(request.Notice);
   default:throw new InvalidDataException("Unknown notification operation.");
  }
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
  if(disposed)return;
  documentGeneration++;
  _=Enqueue(()=>{ClearToasts();return true;});
 }
 void ClearToasts(){
  pending.Clear();
  if(!initialized)return;
  try{ToastNotificationManagerCompat.History.RemoveGroup(Group);}
  catch(Exception error)when(error is InvalidOperationException||NotificationFailure(error)){System.Diagnostics.Trace.WriteLine("Question notifications could not be removed.");}
 }
 void OnActivated(ToastNotificationActivatedEventArgsCompat args){
  const string key="questionNotice=";
  string argument=args.Argument;
  if(!argument.StartsWith(key,StringComparison.Ordinal)||!Guid.TryParseExact(argument[key.Length..],"N",out _))return;
  try{owner.BeginInvoke((Action)(()=>{if(!disposed)_=OpenAsync(argument[key.Length..],documentGeneration);}));}catch(InvalidOperationException){}
 }
 async Task OpenAsync(string token,int generation){
  var notice=await Enqueue(()=>{
   var toast=pending.Values.FirstOrDefault(entry=>entry.Token==token&&entry.Expires>DateTimeOffset.UtcNow);
   if(toast==null)return null;
   try{Clear(toast.Notice.Id);}
   catch(Exception error)when(error is InvalidOperationException||NotificationFailure(error)){System.Diagnostics.Trace.WriteLine("Question notification could not be removed.");}
   return toast.Notice;
  });
  if(notice==null||disposed||generation!=documentGeneration||owner.IsDisposed)return;
  restore();
  try{postMessage(JsonSerializer.Serialize(new{type="desktopQuestionNotificationOpen",id=notice.Id,threadId=notice.ThreadId}));}
  catch(Exception error)when(error is InvalidOperationException or COMException){System.Diagnostics.Trace.WriteLine("Notification target unavailable.");}
 }
 public void Dispose(){
  if(disposed)return;
  disposed=true;
  _=Enqueue(()=>{
   if(initialized)ToastNotificationManagerCompat.OnActivated-=OnActivated;
   ClearToasts();return true;
  });
 }
 internal string Script=>"""
 (()=>{if(window!==window.top)return;const nonce=NONCE,pending=new Map();let sequence=0,status='checking';
 const setStatus=next=>{if(status!==next){status=next;window.dispatchEvent(new Event('codexlight-question-notification-status'));}};
 const request=(operation,data={})=>new Promise((resolve,reject)=>{if(pending.size>=128){reject(new Error('提醒请求过多'));return;}const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(new Error('桌面提醒没有响应'));},5000);pending.set(id,{resolve,reject,timer});window.chrome.webview.postMessage({type:'desktopQuestionNotification',nonce,sequence:id,operation,...data});});
 window.chrome.webview.addEventListener('message',event=>{const v=event.data;if(v?.type==='desktopQuestionNotificationOpen'){window.dispatchEvent(new CustomEvent('codex-light-question-open',{detail:{id:v.id,threadId:v.threadId}}));return;}if(v?.type!=='desktopQuestionNotificationResult')return;const p=pending.get(v.sequence);if(!p)return;pending.delete(v.sequence);clearTimeout(p.timer);v.error?p.reject(new Error(v.error)):p.resolve({status:v.status});
 if(['requested','ready','blocked'].includes(v.status))setStatus(v.status==='requested'?'ready':v.status);});
 Object.defineProperty(window,'codexLightQuestionNotifications',{value:Object.freeze({status:()=>status,refreshStatus:()=>request('status').catch(error=>{setStatus('unavailable');throw error;}),openSettings:()=>request('openSettings'),show:data=>request('show',data),clear:id=>request('clear',{id}),clearAll:()=>request('clearAll')}),writable:false,configurable:false});})();
 """.Replace("NONCE",JsonSerializer.Serialize(nonce));
}
