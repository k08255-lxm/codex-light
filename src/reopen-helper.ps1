# Windows PowerShell 5.1 / .NET Framework. No URL/token in arguments or files.
$ErrorActionPreference = 'Stop'
$pipe = $null
function Assert-PrivatePipe($pipe, $sid) {
  $actual = $pipe.GetAccessControl()
  if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Pipe owner/protection verification failed' }
  $rules = $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rules[0].IsInherited) { throw 'Pipe ACL verification failed' }
}
try {
  $config = [Console]::In.ReadLine() | ConvertFrom-Json
  if ($config.name -notmatch '^codex-light-[a-f0-9]{48}$') { throw 'Invalid pipe name' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($config.mode -eq 'client') {
    $rights = [IO.Pipes.PipeAccessRights]::ReadWrite -bor [IO.Pipes.PipeAccessRights]::ReadPermissions
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $config.name, $rights, [IO.Pipes.PipeOptions]::Asynchronous, [Security.Principal.TokenImpersonationLevel]::Anonymous, [IO.HandleInheritability]::None)
    $pipe.Connect(2000)
    # Authenticate the kernel object's owner and DACL before reading any URL.
    Assert-PrivatePipe $pipe $sid
    $buffer = New-Object byte[] 8192
    $length = 0
    while ($length -lt $buffer.Length) {
      $read = $pipe.ReadAsync($buffer, $length, $buffer.Length - $length)
      if (!$read.Wait(2000)) { throw 'Client read timeout' }
      $count = $read.Result
      if ($count -eq 0) { throw 'Incomplete reopening response' }
      $length += $count
      if ([Array]::IndexOf($buffer, [byte]10, 0, $length) -ge 0) { break }
    }
    if ($length -ge $buffer.Length) { throw 'Oversized reopening response' }
    $pipe.WriteByte(1)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($buffer, 0, $length))
    [Console]::Out.Flush()
    return
  }
  $acl = New-Object System.IO.Pipes.PipeSecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($sid)
  $rule = New-Object System.IO.Pipes.PipeAccessRule($sid, [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  $pipe = New-Object System.IO.Pipes.NamedPipeServerStream($config.name, [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096, $acl)
  Assert-PrivatePipe $pipe $sid
  [Console]::Out.WriteLine('{"ready":true}')
  [Console]::Out.Flush()
  $ownerProcess = [Diagnostics.Process]::GetProcessById([int]$config.parentPid)
  $payload = [Text.Encoding]::UTF8.GetBytes(($config.payload | ConvertTo-Json -Compress) + "`n")
  while (!$ownerProcess.HasExited) {
    $wait = $pipe.WaitForConnectionAsync()
    while (!$wait.IsCompleted -and !$ownerProcess.HasExited) { Start-Sleep -Milliseconds 50 }
    if ($ownerProcess.HasExited) { break }
    $wait.GetAwaiter().GetResult()
    try {
      $write = $pipe.WriteAsync($payload, 0, $payload.Length)
      if (!$write.Wait(2000)) { throw 'Client write timeout' }
      # Disconnect discards unread buffered data, so wait for verified client's ACK.
      $ack = New-Object byte[] 1
      $readAck = $pipe.ReadAsync($ack, 0, 1)
      if (!$readAck.Wait(2000) -or $readAck.Result -ne 1 -or $ack[0] -ne 1) { throw 'Client acknowledgment failed' }
    } finally { if ($pipe.IsConnected) { $pipe.Disconnect() } }
  }
} catch {
  # Never print exception arguments or config, which may include the secret URL.
  [Console]::Error.WriteLine('Private reopening pipe unavailable; no insecure fallback.')
  exit 1
} finally { if ($null -ne $pipe) { $pipe.Dispose() } }
