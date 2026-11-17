using CodexLight.Desktop;
using System.Text.Json;

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
  Console.WriteLine($"Native question notification checks: {count} passed");
 }
}
