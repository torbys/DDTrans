param([Parameter(Mandatory=$true)][string]$PayloadDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$pins = Get-Content -LiteralPath (Join-Path $projectRoot 'native/virtual-audio/vendor.json') -Raw | ConvertFrom-Json
$PayloadDirectory = (Resolve-Path -LiteralPath $PayloadDirectory).Path
$archivePath = Join-Path $PayloadDirectory 'VBCABLE_Driver_Pack45.zip'
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $pins.sha256) { throw 'Bundled original VB-CABLE ZIP does not match the upstream pin.' }
$vendorDirectory = (Resolve-Path -LiteralPath (Join-Path $PayloadDirectory 'vendor')).Path
$prefix = $vendorDirectory + [IO.Path]::DirectorySeparatorChar
$expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    foreach ($entry in $archive.Entries) {
        if (-not $entry.Name) { continue }
        $file = [IO.Path]::GetFullPath((Join-Path $vendorDirectory $entry.FullName))
        if (-not $file.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or -not $expected.Add($file)) { throw 'Invalid or duplicate path in the upstream ZIP.' }
        $stream = $entry.Open()
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { $zipHash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose(); $algorithm.Dispose() }
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $zipHash) { throw "Extracted VB-CABLE payload differs from the original ZIP: $($entry.FullName)" }
    }
} finally { $archive.Dispose() }
$actual = @(Get-ChildItem -LiteralPath $vendorDirectory -Recurse -File)
if ($actual.Count -ne $expected.Count) { throw 'The vendor payload contains missing or extra files.' }
foreach ($file in $actual) { if (-not $expected.Contains($file.FullName)) { throw "Unexpected vendor file: $($file.Name)" } }
$catalog = Get-AuthenticodeSignature -LiteralPath (Join-Path $vendorDirectory 'vbaudio_cable64_win10.cat')
if ($catalog.Status -ne 'Valid' -or $catalog.SignerCertificate.Subject -notmatch '^CN=Microsoft Windows Hardware Compatibility Publisher,') { throw 'Bundled catalog does not have a trusted Microsoft hardware publisher signature.' }
Write-Output "Verified $($expected.Count) original VB-CABLE files against the pinned upstream ZIP and catalog."
