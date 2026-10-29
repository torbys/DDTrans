param([string]$BuildDirectory, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $projectRoot 'data/driver-development/build' }
$BuildDirectory = (Resolve-Path -LiteralPath $BuildDirectory).Path
if (-not $OutputPath) { $OutputPath = Join-Path $projectRoot 'data/driver-development/DDTrans-Virtual-Microphone-dev-x64.zip' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
$files = [ordered]@{
    'package/DDTransVirtualAudio.sys' = Join-Path $BuildDirectory 'package/DDTransVirtualAudio.sys'
    'package/DDTransVirtualAudio.inf' = Join-Path $BuildDirectory 'package/DDTransVirtualAudio.inf'
    'package/DDTransVirtualAudio.cat' = Join-Path $BuildDirectory 'package/DDTransVirtualAudio.cat'
    'ddtrans-device-tool.exe' = Join-Path $BuildDirectory 'ddtrans-device-tool.exe'
    'ddtrans-probe.exe' = Join-Path $BuildDirectory 'ddtrans-probe.exe'
    'DDTrans-Development.cer' = Join-Path $BuildDirectory 'DDTrans-Development.cer'
    'install.ps1' = Join-Path $PSScriptRoot 'install.ps1'
    'INSTALL.md' = Join-Path $PSScriptRoot 'INSTALL.md'
    'LICENSE' = Join-Path $PSScriptRoot 'driver/LICENSE'
}
$hashes = [ordered]@{}
foreach ($file in $files.GetEnumerator()) { $hashes[$file.Key] = (Get-FileHash -LiteralPath $file.Value -Algorithm SHA256).Hash }
$sysSignature = Get-AuthenticodeSignature -LiteralPath $files['package/DDTransVirtualAudio.sys']
$catSignature = Get-AuthenticodeSignature -LiteralPath $files['package/DDTransVirtualAudio.cat']
if ($sysSignature.SignerCertificate.Subject -ne 'CN=DDTrans Local Driver Development' -or $catSignature.SignerCertificate.Thumbprint -ne $sysSignature.SignerCertificate.Thumbprint) { throw 'Run driver:sign-dev on the current build before packaging.' }
$manifest = [ordered]@{ developmentOnly=$true; kernelRuntimeVerified=$false; files=$hashes } | ConvertTo-Json -Depth 4
$manifestPath = Join-Path $BuildDirectory 'package-manifest.json'
$manifest | Set-Content -LiteralPath $manifestPath -Encoding utf8
$files['package-manifest.json'] = $manifestPath
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipStream = [IO.File]::Open($OutputPath, [IO.FileMode]::Create, [IO.FileAccess]::Write)
$archive = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files.GetEnumerator()) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.Value, $file.Key, [IO.Compression.CompressionLevel]::Optimal) | Out-Null }
} finally { $archive.Dispose(); $zipStream.Dispose() }
Write-Output "Development package: $OutputPath"
Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256
