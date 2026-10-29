param([string]$Destination)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (-not $Destination) { $Destination = Join-Path $projectRoot 'data/driver-development' }
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$Destination = (Resolve-Path -LiteralPath $Destination).Path
$version = '10.0.26100.6584'
$archive = Join-Path $Destination "wdk.$version.zip"
$uri = "https://api.nuget.org/v3-flatcontainer/microsoft.windows.wdk.x64/$version/microsoft.windows.wdk.x64.$version.nupkg"
$expectedHash = 'C393D03DFB640B5C92F546B32F6770EF68CD3AAF691956E7D66D8E2C28A1B55E'
if (-not (Test-Path -LiteralPath $archive)) {
    $metadata = Invoke-WebRequest -Uri $uri -Method Head
    $length = [long]$metadata.Headers['Content-Length'][0]
    if ($length -ne 110872506 -or $length -gt 5000000000) { throw 'Unexpected package size; stopped before downloading.' }
    $partial = "$archive.partial"
    try {
        Invoke-WebRequest -Uri $uri -OutFile $partial
        if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $expectedHash) { throw 'WDK checksum mismatch.' }
        Move-Item -LiteralPath $partial -Destination $archive
    } finally { if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial } }
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) { throw 'WDK checksum mismatch.' }
$extracted = Join-Path $Destination 'wdk'
if (-not (Test-Path -LiteralPath (Join-Path $extracted 'c/Include/10.0.26100.0/km/wdm.h'))) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try { if (($zip.Entries | Measure-Object Length -Sum).Sum -gt 5000000000) { throw 'Expanded package exceeds the agreed size limit.' } } finally { $zip.Dispose() }
    Expand-Archive -LiteralPath $archive -DestinationPath $extracted
}
Write-Output "WDK ready: $extracted/c (download 110872506 bytes; expanded approximately 319 MB)."
