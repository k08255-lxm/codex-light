using System;using System.IO;using System.Linq;using System.Reflection;using System.Collections.Generic;using System.Runtime.Serialization;using System.Runtime.Serialization.Json;using System.Security.Cryptography;
namespace CodexLight.Bootstrap {
 [DataContract]internal sealed class LegacyEvidence {
  [DataMember(Name="target")]public string Target="";
  [DataMember(Name="legacyId")]public string LegacyId="";
  [DataMember(Name="recognitionOnly")]public bool RecognitionOnly=false;
  [DataMember(Name="files")]public List<PayloadFile> Files=new List<PayloadFile>();
 }
 internal static class LegacyRepair {
  // Recognition only. No registration, file replacement, or implicit ownership of unknown files.
  public static InstallReceipt Recognize(string target,bool confirmed){
   if(!confirmed)throw new InvalidOperationException("Legacy repair recognition needs explicit confirmation");
   const string name="CodexLight.LegacyV7Evidence";var assembly=Assembly.GetExecutingAssembly();LegacyEvidence evidence;
   using(var stream=assembly.GetManifestResourceStream(name)){if(stream==null)throw new InvalidOperationException("No reviewed legacy evidence in this installer");using(var memory=new MemoryStream()){stream.CopyTo(memory);var bytes=memory.ToArray();using(var sha=SHA256.Create()){if(BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant()!="c722ca8cfedecf4985e52a95bc6a1bbab0e8eb19a1710d44fddaef16280e8e76")throw new InvalidOperationException("Legacy evidence hash mismatch");}memory.Position=0;evidence=(LegacyEvidence)new DataContractJsonSerializer(typeof(LegacyEvidence)).ReadObject(memory)!;}}
   if(!evidence.RecognitionOnly||evidence.LegacyId!="codex-light-v7-framework-dependent-40files"||evidence.Files.Count!=42||!string.Equals(Path.GetFullPath(target).TrimEnd('\\'),evidence.Target,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Legacy target/evidence mismatch");
   var files=UpgradePlanner.ValidateFiles(evidence.Files.Select(x=>new UpgradeFile(x.Path,x.Size,x.Hash)));
   foreach(var file in files){var full=Path.Combine(target,file.Path.Replace('/',Path.DirectorySeparatorChar));for(string? current=full;!string.IsNullOrEmpty(current);current=Path.GetDirectoryName(current)){if((File.Exists(current)||Directory.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("Legacy repair never follows links");}if(!File.Exists(full)||new FileInfo(full).Length!=file.Size)throw new InvalidOperationException("Legacy managed file missing or modified");if(BoundedFile.Hash(full,file.Size)!=file.Sha256)throw new InvalidOperationException("Legacy managed file hash mismatch");}
   return new InstallReceipt(Guid.NewGuid().ToString("D"),evidence.Target,files);
  }
 }
}
