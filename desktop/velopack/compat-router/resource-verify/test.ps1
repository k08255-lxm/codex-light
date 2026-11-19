param([Parameter(Mandatory=$true)][string]$Verifier,[Parameter(Mandatory=$true)][string]$Exe,[Parameter(Mandatory=$true)][string]$FreshSha256,[Parameter(Mandatory=$true)][string]$HelperSha256)
$ErrorActionPreference='Stop'
function VerifyCase([int]$ExpectedExit,[string]$Message,[string[]]$Pairs){
 $previous=$ErrorActionPreference
 try{$ErrorActionPreference='Continue';$result=& dotnet $Verifier $Exe @Pairs 2>&1;$actualExit=$LASTEXITCODE}finally{$ErrorActionPreference=$previous}
 if($actualExit -ne $ExpectedExit -or ($result|Out-String) -notmatch $Message){throw "Unexpected verifier result: $actualExit $result"}
}
VerifyCase 0 'Verified 2 embedded resource hashes' @('CodeCang.Fresh.zip',$FreshSha256,'CodeCang.Repair.zip',$HelperSha256)
VerifyCase 1 'Resource SHA256 mismatch' @('CodeCang.Fresh.zip',('0'*64))
VerifyCase 1 'Missing resources' @('CodeCang.Repair.nupkg',$FreshSha256)
VerifyCase 1 'Duplicate expected resource' @('CodeCang.Fresh.zip',$FreshSha256,'CodeCang.Fresh.zip',$FreshSha256)
Write-Output 'Passed 4 resource verifier checks against PE bytes; the installer was never launched.'
