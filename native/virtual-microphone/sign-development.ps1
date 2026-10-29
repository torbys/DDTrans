param([string]$BuildDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $projectRoot 'data/driver-development/build' }
$BuildDirectory = (Resolve-Path -LiteralPath $BuildDirectory).Path
$sdkRoot = (Get-ItemProperty 'HKLM:/SOFTWARE/Wow6432Node/Microsoft/Windows Kits/Installed Roots').KitsRoot10
$signtool = Join-Path $sdkRoot 'bin/10.0.26100.0/x64/signtool.exe'
$wdkRoot = Join-Path $projectRoot 'data/driver-development/wdk/c'
$package = Join-Path $BuildDirectory 'package'
$certificateSubject = 'CN=DDTrans Local Driver Development'
$certificate = Get-ChildItem Cert:/CurrentUser/My -CodeSigningCert | Where-Object { $_.Subject -eq $certificateSubject -and $_.NotAfter -gt (Get-Date).AddDays(7) -and $_.HasPrivateKey } | Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $certificate) { $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $certificateSubject -CertStoreLocation Cert:/CurrentUser/My -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(1) }
& $signtool sign /fd SHA256 /s My /sha1 $certificate.Thumbprint (Join-Path $package 'DDTransVirtualAudio.sys')
if ($LASTEXITCODE -ne 0) { throw 'Development binary signing failed.' }
& (Join-Path $wdkRoot 'bin/10.0.26100.0/x86/Inf2Cat.exe') "/driver:$package" /os:10_CO_X64,10_NI_X64,10_GE_X64
if ($LASTEXITCODE -ne 0) { throw 'Catalog regeneration after signing failed.' }
& $signtool sign /fd SHA256 /s My /sha1 $certificate.Thumbprint (Join-Path $package 'DDTransVirtualAudio.cat')
if ($LASTEXITCODE -ne 0) { throw 'Development catalog signing failed.' }
Export-Certificate -Cert $certificate -FilePath (Join-Path $BuildDirectory 'DDTrans-Development.cer') -Force | Out-Null
[ordered]@{ developmentOnly=$true; package=$package; subject=$certificate.Subject; certificateThumbprint=$certificate.Thumbprint; trustedRootChanged=$false; bootConfigurationChanged=$false; rebootPerformed=$false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $BuildDirectory 'development-signing.json') -Encoding utf8
Write-Output 'Development signatures created. No root certificate was trusted, no driver was installed, and no boot settings were changed.'
