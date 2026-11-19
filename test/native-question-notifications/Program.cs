using CodexLight.Desktop;
using System.Text.Json;
using System.Xml.Linq;

static class Program {
 static int count;
 static void Check(bool value,string name){count++;if(!value)throw new Exception(name);}
 static void Reject(Action action){try{action();throw new Exception("accepted invalid request");}catch(Exception error)when(error is InvalidDataException or JsonException or InvalidOperationException or KeyNotFoundException){count++;}}
 static void Main(){
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
  Console.WriteLine($"Native question notification checks: {count} passed");
 }
}
