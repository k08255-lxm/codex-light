param(
  [Parameter(Mandatory=$true)][string]$Directory,
  [Parameter(Mandatory=$true)][ValidateSet('CodexLight.UpdateWorker','CodeCang.BootstrapWorker')][string]$Name
)
$ErrorActionPreference = 'Stop'
$entry = Join-Path $Directory ($Name + '.exe')
$output = @(& $entry --verify-entrypoint)
if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1 -or $output[0] -cne $Name) {
  throw "Published $Name failed its native entrypoint check (exit $LASTEXITCODE)."
}
Write-Output "Verified native entrypoint: $Name"
