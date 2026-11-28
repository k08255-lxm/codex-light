using System.Text.Json;

namespace CodexLight.Desktop;

internal enum CompanionPose { Idle, Work, Read, Cheer, Low, Question, Approval, Offline, Greet }

internal sealed record QuotaWindow(int Minutes, double Remaining) {
 internal string Label => Minutes == 10080 ? "每周" : $"{Minutes / 60} 小时";
 internal string ShortLabel => Minutes == 10080 ? "本周" : $"{Minutes / 60}h";
 internal string Percent => $"{Math.Round(Remaining, MidpointRounding.AwayFromZero)}%";
}

internal sealed record CompanionState(string Character, bool Dark, bool ReducedMotion, bool Connected,
 int Running, int Questions, int Approvals, QuotaWindow[] Quota, bool Stale) {
 internal string Name => Character == "lulu" ? "水豚噜噜" : "奶龙";
 internal QuotaWindow? Limiting => Quota.MinBy(window => window.Remaining);
 internal CompanionPose Activity => !Connected ? CompanionPose.Offline : Questions > 0 ? CompanionPose.Question
  : Approvals > 0 ? CompanionPose.Approval : Running > 0 ? CompanionPose.Work : CompanionPose.Idle;
 internal string Status => Activity switch {
  CompanionPose.Offline => "连接已断开", CompanionPose.Question => $"等你回答 · {Questions} 项",
  CompanionPose.Approval => $"等你审批 · {Approvals} 项", CompanionPose.Work => $"{Running} 个任务进行中",
  _ => "待机中"
 };
 internal string Summary {
  get {
   if (Activity is not (CompanionPose.Idle or CompanionPose.Work) || Stale || Limiting is not {} limit) return Status;
   string task = Running switch { 0 => "待机", 1 => "工作中", _ => $"{Running} 项运行" };
   return $"{task} · {limit.ShortLabel} 剩 {limit.Percent}";
  }
 }
 internal CompanionPose Pose(double seconds) {
  var activity = Activity;
  if (activity is not (CompanionPose.Work or CompanionPose.Idle)) return activity;
  var remaining = Stale ? null : Limiting?.Remaining;
  // Keep the task legible while allowing a short allowance gesture each cycle.
  double phase = seconds % 12;
  if (remaining <= 10 && (activity == CompanionPose.Idle || phase >= 9)) return CompanionPose.Low;
  if (activity == CompanionPose.Work) return phase is >= 6 and < 9 ? CompanionPose.Read : CompanionPose.Work;
  return remaining > 30 && phase >= 8 ? CompanionPose.Cheer : CompanionPose.Idle;
 }

 internal CompanionState Offline() => this with { Connected = false, Running = 0, Questions = 0, Approvals = 0, Quota = [], Stale = false };

 internal static bool TryRead(string json, out CompanionState? state) {
  state = null;
  if (json.Length > 2048) return false;
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
   state = new(character,dark,reduced,connected,running,questions,approvals,[..quota],stale);
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
