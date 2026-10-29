param(
    [ValidateSet('Check','Install','Remove')][string]$Action = 'Check',
    [string]$BuildDirectory
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (-not $BuildDirectory) {
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'ddtrans-device-tool.exe')) { $BuildDirectory = $PSScriptRoot }
    else { $BuildDirectory = Join-Path $projectRoot 'data/driver-development/build' }
}
$BuildDirectory = (Resolve-Path -LiteralPath $BuildDirectory).Path
$tool = Join-Path $BuildDirectory 'ddtrans-device-tool.exe'
$package = Join-Path $BuildDirectory 'package'
$signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $package 'DDTransVirtualAudio.cat')
$secureBoot = (Get-ItemProperty 'HKLM:/SYSTEM/CurrentControlSet/Control/SecureBoot/State' -ErrorAction SilentlyContinue).UEFISecureBootEnabled -eq 1
$isDevelopment = $signature.SignerCertificate -and $signature.SignerCertificate.Subject -eq 'CN=DDTrans Local Driver Development'
$nativeStatus = & $tool status | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Unable to query native audio endpoints and code integrity policy.' }
$administrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Action -eq 'Check') {
    $nativeStatus | ConvertTo-Json -Depth 6
    [ordered]@{ signatureStatus=$signature.Status.ToString(); developmentPackage=[bool]$isDevelopment; secureBootEnabled=$secureBoot; administrator=$administrator; changesMade=$false } | ConvertTo-Json
    return
}
if (-not $administrator) { throw 'Open an elevated PowerShell to install or remove this device. No changes were made.' }
if ($Action -eq 'Install') {
    if ($isDevelopment -and $secureBoot) { throw 'Development driver cannot be installed under this Secure Boot policy. Arrange a test-signing environment and reboot first; this script never changes boot settings.' }
    if ($isDevelopment -and $nativeStatus.testSigningEnabled -ne $true) { throw 'Test signing is not active. Stop here and arrange the test-machine boot configuration and restart; no device was created.' }
    if ($signature.Status -ne 'Valid') { throw "Package signature is not trusted ($($signature.Status)). No device was created." }
    & $tool install (Join-Path $package 'DDTransVirtualAudio.inf')
} else { & $tool remove }
$operationExit = $LASTEXITCODE
if ($operationExit -eq 3010) { Write-Output 'Windows reports that a reboot is required. Restart manually when ready; no reboot was scheduled.'; exit 3010 }
if ($operationExit -ne 0) { throw "Device operation failed (Win32 $operationExit)." }
& $tool status
