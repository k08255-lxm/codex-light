param(
    [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string[]]$FilePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9A-Fa-f]{40}$')][string]$CertificateThumbprint,
    [ValidateSet('CurrentUser','LocalMachine')][string]$CertificateStore='CurrentUser'
)
$ErrorActionPreference='Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Authenticode release signing requires Windows.' }

# Use only the explicitly selected existing certificate. Never import/create one.
$certificatePath='Cert:\' + $CertificateStore + '\My\' + $CertificateThumbprint
$certificate=Get-Item -LiteralPath $certificatePath
$now=Get-Date
if (!$certificate.HasPrivateKey -or $now -lt $certificate.NotBefore -or $now -gt $certificate.NotAfter) {
    throw 'The selected certificate must be currently valid and have its private key.'
}
$codeSigning=$false
foreach ($extension in $certificate.Extensions) {
    if ($extension.Oid.Value -eq '2.5.29.37') {
        foreach ($usage in $extension.EnhancedKeyUsages) {
            if ($usage.Value -eq '1.3.6.1.5.5.7.3.3') { $codeSigning=$true }
        }
    }
}
if (!$codeSigning) { throw 'The selected certificate does not explicitly permit Code Signing.' }
$targets=@(foreach ($path in $FilePath) {
    $file=Get-Item -LiteralPath $path
    if ($file.PSIsContainer -or $file.Extension -ne '.exe') { throw 'Specify existing release EXE files only.' }
    $file.FullName
})

# DigiCert's published Authenticode TSA URL; Windows PowerShell requires http://.
# Trust is checked through the signed timestamp and Authenticode verification.
$timestampServer='http://timestamp.digicert.com'
foreach ($target in ($targets | Select-Object -Unique)) {
    $signature=Set-AuthenticodeSignature -LiteralPath $target -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer $timestampServer -IncludeChain NotRoot
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate) {
        throw ('Signing/timestamp verification failed for '+$target+': '+$signature.Status+'. The file may already be modified; do not publish or hash it as a signed release.')
    }
    $verified=Get-AuthenticodeSignature -LiteralPath $target
    if ($verified.Status -ne 'Valid' -or $null -eq $verified.TimeStamperCertificate -or $verified.SignerCertificate.Thumbprint -ne $CertificateThumbprint) {
        throw ('Post-sign verification failed for '+$target+'. Do not publish this file.')
    }
    Write-Output ('Signed and timestamp-verified: '+$target)
}
