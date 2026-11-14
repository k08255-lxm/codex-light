using CodexLight.Desktop;
using System.Reflection;
using System.Text.Json;
static class Program {
 static int count;static void Check(bool v,string name){count++;if(!v)throw new Exception(name);}
 static void Reject(Action action){try{action();throw new Exception("accepted invalid input");}catch(Exception e)when(e is InvalidDataException or KeyNotFoundException or JsonException or InvalidOperationException){count++;}}
 [STAThread]static void Main(){
  Application.EnableVisualStyles();var root=Path.Combine(Path.GetTempPath(),"codex-close-tests-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);var path=Path.Combine(root,"close.json");var store=new CloseBehaviorStore(path);
  Check(store.Load()==CloseBehavior.Ask&&!store.ReadFailed,"first use asks");
  foreach(var mode in new[]{CloseBehavior.Tray,CloseBehavior.Exit,CloseBehavior.Ask}){Check(store.Save(mode),"save");Check(new CloseBehaviorStore(path).Load()==mode,"survives fresh instance");}
  foreach(var json in new[]{"{}","{broken","{\"version\":2,\"behavior\":\"exit\"}","{\"version\":1,\"behavior\":\"wrong\"}",new string('x',1025)}){File.WriteAllText(path,json);Check(store.Load()==CloseBehavior.Ask&&store.ReadFailed,"invalid state safely asks");}
  Check(!new CloseBehaviorStore(root).Save(CloseBehavior.Exit),"failure is reported");Check(!store.Save((CloseBehavior)99),"invalid enum not persisted");
  string nonce="test-nonce";string Message(string operation,string? behavior=null,string token="test-nonce")=>JsonSerializer.Serialize(behavior==null?new Dictionary<string,object>{{"type","desktopCloseBehavior"},{"nonce",token},{"id","1"},{"operation",operation}}:new Dictionary<string,object>{{"type","desktopCloseBehavior"},{"nonce",token},{"id","1"},{"operation",operation},{"behavior",behavior}});
  Check(CloseBehaviorBridge.Read(Message("get"),nonce).Operation=="get","get request");
  foreach(var mode in new[]{"ask","tray","exit"})Check(CloseBehaviorBridge.Read(Message("set",mode),nonce).Behavior==CloseBehaviorStore.Parse(mode),"set enum");
  Reject(()=>CloseBehaviorBridge.Read(Message("set","exit","wrong"),nonce));Reject(()=>CloseBehaviorBridge.Read(Message("set","invalid"),nonce));Reject(()=>CloseBehaviorBridge.Read(Message("set"),nonce));Reject(()=>CloseBehaviorBridge.Read(Message("get","exit"),nonce));Reject(()=>CloseBehaviorBridge.Read(Message("execute"),nonce));
  var origin=new Uri("http://127.0.0.1:12345");Check(LocalPathLinks.TrustedSource("http://127.0.0.1:12345/#token=x",origin),"native origin");foreach(string source in new[]{"http://192.168.1.2:12345/","http://127.0.0.1:12346/","http://127.0.0.1:12345/frame","https://example.com/"})Check(!LocalPathLinks.TrustedSource(source,origin),"remote/frame origin rejected");
  foreach(var choice in new[]{CloseChoice.Cancel,CloseChoice.Tray,CloseChoice.Exit}){
   using var dialog=new CloseChoiceDialog(Color.White,Color.Black);var check=(CheckBox)typeof(CloseChoiceDialog).GetField("remember",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(dialog)!;
   Check(!check.Checked&&!dialog.RememberChoice,"every unremembered prompt starts unchecked");check.Checked=true;
   string text=choice==CloseChoice.Cancel?"取消":choice==CloseChoice.Tray?"转入托盘":"退出并停止";
   Button Find(Control c){foreach(Control child in c.Controls){if(child is Button b&&b.Text==text)return b;try{return Find(child);}catch(InvalidOperationException){}}throw new InvalidOperationException();}
   typeof(Control).GetMethod("OnClick",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(Find(dialog),new object[]{EventArgs.Empty});
   Check(dialog.Choice==choice,"chosen action");Check(dialog.RememberChoice==(choice!=CloseChoice.Cancel),"cancel never remembers");
  }
  Console.WriteLine($"Passed {count} close behavior assertions; isolated fixtures: {root}");
 }
}
