# Shared read-only guard; dot-sourcing performs no inventory or installation.
function SameRoot([string]$a,[string]$b){return [IO.Path]::GetFullPath($a).TrimEnd('\').Equals([IO.Path]::GetFullPath($b).TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)}
function Assert-FixtureIdentity($identity,$plan,[string]$root){
 if($identity.State -ne 5 -or $identity.Name -ne $plan.FixtureId -or $identity.Assignment -ne '0' -or $identity.Version -ne '1.0.0' -or !(SameRoot $identity.Source $root)){throw 'Installed fixture ownership differs'}
}
function Get-FixtureIdentity($installer,$plan){
 $state=$installer.ProductState($plan.ProductCode)
 if($state -eq -1){return [pscustomobject]@{State=-1}}
 return [pscustomobject]@{State=$state;Name=$installer.ProductInfo($plan.ProductCode,'InstalledProductName');Assignment=$installer.ProductInfo($plan.ProductCode,'AssignmentType');Version=$installer.ProductInfo($plan.ProductCode,'VersionString');Source=$installer.ProductInfo($plan.ProductCode,'InstallSource')}
}
function Get-FixtureArp([string]$key){
 foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)){
  foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)){
   $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);$k=$null
   try{$k=$base.OpenSubKey($key);if($k){[pscustomobject]@{Hive="$hive";View="$view";DisplayName=$k.GetValue('DisplayName');InstallLocation=$k.GetValue('InstallLocation')}}}finally{if($k){$k.Dispose()};$base.Dispose()}
  }
 }
}
function Test-FixtureOldRegistered($installer,$plan,[string]$root){
 $identity=Get-FixtureIdentity $installer $plan
 if($identity.State -eq -1){return $false}
 Assert-FixtureIdentity $identity $plan $root
 return $true
}
