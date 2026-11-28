using System.Text.Json;

namespace CodexLight.Desktop;

internal enum CompanionPose { Idle, Work, Thinking, Command, Team, Cheer, Low, Question, Approval, Offline, Greet }

internal sealed record QuotaWindow(int Minutes, double Remaining) {
 internal string Label => Minutes == 10080 ? "每周" : $"{Minutes / 60} 小时";
 internal string ShortLabel => Minutes == 10080 ? "本周" : $"{Minutes / 60}h";
 internal string Percent => $"{Math.Round(Remaining, MidpointRounding.AwayFromZero)}%";
}

internal sealed record CompanionState(string Character, bool Dark, bool ReducedMotion, bool Connected,
 int Running, int Questions, int Approvals, QuotaWindow[] Quota, bool Stale, int SizePercent=100, CompanionPose WorkPhase=CompanionPose.Work) {
 internal int Agents {get;init;}
 internal string[] TaskNames {get;init;}=[];
 internal const int MinSize=50, MaxSize=200, SizeStep=25;
 internal string Name => Character == "lulu" ? "水豚噜噜" : "奶龙";
 internal QuotaWindow? Limiting => Quota.MinBy(window => window.Remaining);
 internal CompanionPose Activity => !Connected ? CompanionPose.Offline : Questions > 0 ? CompanionPose.Question
  : Approvals > 0 ? CompanionPose.Approval : Agents > 0 ? CompanionPose.Team : Running > 0 ? WorkPhase : CompanionPose.Idle;
 internal string Status => Activity switch {
  CompanionPose.Offline => "连接已断开", CompanionPose.Question => $"等你回答 · {Questions} 项",
  CompanionPose.Approval => $"等你审批 · {Approvals} 项", CompanionPose.Work => $"{Running} 个任务进行中",
  CompanionPose.Thinking => "思考中", CompanionPose.Command => "执行命令中", CompanionPose.Team => "子代理协作中",
  _ => "待机中"
 };
 internal string Summary {
  get {
   if (Activity is CompanionPose.Question or CompanionPose.Approval or CompanionPose.Offline || Stale || Limiting is not {} limit) return Status;
   string task = Activity switch { CompanionPose.Idle => "待机", CompanionPose.Work when Running==1 => "工作中",
    CompanionPose.Work => $"{Running} 项运行", _ => Status };
   return $"{task} · {limit.ShortLabel} 剩 {limit.Percent}";
  }
 }
 internal CompanionPose Pose => Activity==CompanionPose.Idle && !Stale && Limiting?.Remaining<=10 ? CompanionPose.Low : Activity;
 internal bool RecoveredFrom(CompanionState previous) =>
  Character==previous.Character && Activity==CompanionPose.Idle && previous.Pose==CompanionPose.Low && !Stale &&
  Limiting?.Remaining>30 && previous.Limiting is {} low && Quota.Any(q=>q.Minutes==low.Minutes);

 internal CompanionState Offline() => this with { Connected = false, Running = 0, Agents = 0, TaskNames = [], Questions = 0, Approvals = 0, Quota = [], Stale = false };

 internal static bool TryRead(string json, out CompanionState? state) {
  state = null;
  if (json.Length > 32768) return false;
  try {
   using var document = JsonDocument.Parse(json);
   var root = document.RootElement;
   if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("character",out var id) || id.ValueKind != JsonValueKind.String) return false;
   string? character = id.GetString();
   if (character == "off") return true;
   if (character is not ("nailong" or "lulu") || !Flag("dark",out bool dark) || !Flag("reducedMotion",out bool reduced)
    || !Flag("connected",out bool connected) || !Flag("stale",out bool stale) || !Count("running",out int running)
    || !Count("questions",out int questions) || !Count("approvals",out int approvals)
    || !root.TryGetProperty("quota",out var rows) || rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() > 2) return false;
   var quota = new List<QuotaWindow>();
   foreach (var row in rows.EnumerateArray()) {
    if (row.ValueKind != JsonValueKind.Object || !row.TryGetProperty("minutes",out var minutes) || minutes.ValueKind != JsonValueKind.Number
     || !minutes.TryGetInt32(out int duration) || !(duration == 10080 || duration is >= 60 and < 1440 && duration % 60 == 0)
     || !row.TryGetProperty("remaining",out var amount) || amount.ValueKind != JsonValueKind.Number
     || !amount.TryGetDouble(out double remaining) || !double.IsFinite(remaining) || remaining is < 0 or > 100) return false;
    quota.Add(new(duration,remaining));
   }
   // A previous web bundle has neither field and uses the original size and generic work pose.
   int size=100;
   if (root.TryGetProperty("size",out _) && (!Count("size",out size) || size is < MinSize or > MaxSize || size % SizeStep!=0)) return false;
   var phase=CompanionPose.Work;
   if(root.TryGetProperty("phase",out var stage)){
    if(stage.ValueKind!=JsonValueKind.String)return false;
    switch(stage.GetString()){
     case "work": break;
     case "thinking": phase=CompanionPose.Thinking;break;
     case "command": phase=CompanionPose.Command;break;
     case "team": phase=CompanionPose.Team;break;
     default:return false;
    }
   }
   int agents=0;
   if(root.TryGetProperty("agents",out _) && !Count("agents",out agents))return false;
   var names=new List<string>();
   if(root.TryGetProperty("taskNames",out var titles)){
    if(titles.ValueKind!=JsonValueKind.Array || titles.GetArrayLength()>32)return false;
    foreach(var title in titles.EnumerateArray()){
     if(title.ValueKind!=JsonValueKind.String || title.GetString() is not {Length:>0 and <=64} name || name.Any(char.IsControl))return false;
     names.Add(name);
    }
   }
   state = new(character,dark,reduced,connected,running,questions,approvals,[..quota],stale,size,phase){Agents=agents,TaskNames=[..names]};
   if (!connected) state = state.Offline();
   return true;

   bool Flag(string key,out bool value) {
    value = false;
    if (!root.TryGetProperty(key,out var field) || field.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
    value = field.GetBoolean(); return true;
   }
   bool Count(string key,out int value) {
    value = 0;
    return root.TryGetProperty(key,out var field) && field.ValueKind == JsonValueKind.Number && field.TryGetInt32(out value) && value >= 0;
   }
  } catch (JsonException) { return false; }
 }
}
