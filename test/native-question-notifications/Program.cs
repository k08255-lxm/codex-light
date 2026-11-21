using CodexLight.Desktop;
using System.Text.Json;
using System.Xml.Linq;

static class Program {
 static int count;
 static void Check(bool value,string name){count++;if(!value)throw new Exception(name);}
 static void Reject(Action action){try{action();throw new Exception("accepted invalid request");}catch(Exception error)when(error is InvalidDataException or JsonException or InvalidOperationException or KeyNotFoundException){count++;}}
 [STAThread] static void Main(){
  string Message(string operation="show",string nonce="nonce",string kind="question",string thread="thread-1",string id="question-1")=>JsonSerializer.Serialize(new Dictionary<string,object>{["type"]="desktopQuestionNotification",["nonce"]=nonce,["sequence"]="1",["operation"]=operation,["id"]=id,["threadId"]=thread,["kind"]=kind});
  var valid=QuestionNotificationBridge.Read(Message(),"nonce");Check(valid.Notice.ThreadId=="thread-1"&&valid.Notice.Kind=="question","valid question");
  Check(QuestionNotificationBridge.Read(Message(kind:"approval"),"nonce").Notice.Kind=="approval","approval supported");
  Reject(()=>QuestionNotificationBridge.Read(Message(nonce:"wrong"),"nonce"));
  Reject(()=>QuestionNotificationBridge.Read(Message(operation:"answer"),"nonce"));
  Reject(()=>QuestionNotificationBridge.Read(Message(kind:"command"),"nonce"));
  Reject(()=>QuestionNotificationBridge.Read(Message(thread:"thread\nspoof"),"nonce"));
  Reject(()=>QuestionNotificationBridge.Read(Message(id:"question\nspoof"),"nonce"));
  Reject(()=>QuestionNotificationBridge.Read(Message().Replace("\"kind\"","\"extra\""),"nonce"));
  Reject(()=>QuestionNotificationBridge.Read(new string('x',4097),"nonce"));
  var clear=JsonSerializer.Serialize(new{type="desktopQuestionNotification",nonce="nonce",sequence="2",operation="clear",id="question-1"});
  Check(QuestionNotificationBridge.Read(clear,"nonce").Operation=="clear","individual clear");
  var reset=JsonSerializer.Serialize(new{type="desktopQuestionNotification",nonce="nonce",sequence="3",operation="clearAll"});
  Check(QuestionNotificationBridge.Read(reset,"nonce").Operation=="clearAll","session reset");
  foreach(var operation in new[]{"status","openSettings"}){
   Check(QuestionNotificationBridge.Read(reset.Replace("clearAll",operation),"nonce").Operation==operation,operation);
   Reject(()=>QuestionNotificationBridge.Read(Message(operation:operation),"nonce"));
  }
  Check(QuestionNotificationBridge.Read(Message(id:"async-thread-1|item-1"),"nonce").Notice.Id=="async-thread-1|item-1","async question identity");
  string token=Guid.NewGuid().ToString("N");
  var toast=XElement.Parse(QuestionNotificationBridge.BuildContent(valid.Notice.Kind,token).GetContent());
  Check(toast.Attribute("launch")?.Value=="questionNotice="+token,"opaque toast click target");
  Check(toast.Descendants("text").Any(x=>x.Value=="Codex 等待你的回答"),"question wording");
  Check(!toast.ToString().Contains(valid.Notice.Id)&&!toast.ToString().Contains(valid.Notice.ThreadId),"toast excludes request identity");
  Check(QuestionNotificationBridge.BuildContent("approval",token).GetContent().Contains("Codex 等待你的审批"),"approval wording");
  SlowNotificationService();
  Console.WriteLine($"Native question notification checks: {count} passed");
 }

 static void SlowNotificationService(){
  using var form=new Form();
  _=form.Handle; // Run the real WinForms message pump without showing a window.
  using var release=new ManualResetEventSlim();
  var started=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
  var replies=new List<string>();
  var delivered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
  int calls=0,uiThread=Environment.CurrentManagedThreadId;
  using var bridge=new QuestionNotificationBridge(form,json=>{
   Check(Environment.CurrentManagedThreadId==uiThread,"WebView reply runs on the UI thread");
   replies.Add(json);
   delivered.TrySetResult();
  },()=>{},()=>{
   Interlocked.Increment(ref calls);
   started.TrySetResult();
   if(!release.Wait(TimeSpan.FromSeconds(5)))throw new TimeoutException("Notification service blocked the UI thread");
   return "ready";
  });
  string nonce=System.Text.RegularExpressions.Regex.Match(bridge.Script,"nonce=\"([a-f0-9]+)\"").Groups[1].Value;
  void Query(int id)=>Check(bridge.Handle(JsonSerializer.Serialize(new{type="desktopQuestionNotification",nonce,sequence=id.ToString(),operation="status"})),"status accepted");
  using var loop=new ApplicationContext();
  Exception? failure=null;
  async void Exercise(){
   try{
    Query(1);
    await started.Task.WaitAsync(TimeSpan.FromSeconds(3));
    // Interleave navigation and focus while the real call site waits for Windows.
    bridge.ClearAll();
    Query(2);
    var pulse=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    form.BeginInvoke((Action)(()=>pulse.SetResult()));
    await pulse.Task.WaitAsync(TimeSpan.FromSeconds(3));
    Check(replies.Count==0,"window messages run before the notification service recovers");
    release.Set();
    await delivered.Task.WaitAsync(TimeSpan.FromSeconds(3));
    using var result=JsonDocument.Parse(replies.Single());
    Check(result.RootElement.GetProperty("sequence").GetString()=="2","stale document reply suppressed");
    Check(result.RootElement.GetProperty("status").GetString()=="ready"&&calls==1,"one native lookup shared across pending requests");
   }catch(Exception error){failure=error;}
   finally{release.Set();loop.ExitThread();}
  }
  form.BeginInvoke((Action)Exercise);
  Application.Run(loop);
  if(failure!=null)throw failure;
 }
}
