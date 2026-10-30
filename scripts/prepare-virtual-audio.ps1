param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'data/virtual-audio/build' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$sourceRoot = Join-Path $projectRoot 'native/virtual-audio'
$vendor = Get-Content -LiteralPath (Join-Path $sourceRoot 'vendor.json') -Raw | ConvertFrom-Json
$archiveName = 'VBCABLE_Driver_Pack45.zip'
$archive = Join-Path $OutputDirectory $archiveName
$cached = Join-Path $projectRoot "data/driver-development/vendor-evaluation/$archiveName"
if (-not (Test-Path -LiteralPath $archive)) {
    if (Test-Path -LiteralPath $cached) { Copy-Item -LiteralPath $cached -Destination $archive }
    else { Invoke-WebRequest -Uri $vendor.url -OutFile $archive -TimeoutSec 60 }
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $vendor.sha256) { throw 'VB-CABLE archive SHA-256 does not match the pinned upstream package.' }
$vendorDirectory = Join-Path $OutputDirectory 'vendor'
Expand-Archive -LiteralPath $archive -DestinationPath $vendorDirectory -Force
& (Join-Path $PSScriptRoot 'verify-virtual-audio-payload.ps1') -PayloadDirectory $OutputDirectory
foreach ($file in $vendor.files.PSObject.Properties) {
    if ((Get-FileHash -LiteralPath (Join-Path $vendorDirectory $file.Name) -Algorithm SHA256).Hash -ne $file.Value) { throw "VB-CABLE file hash mismatch: $($file.Name)" }
}
$catalog = Join-Path $vendorDirectory 'vbaudio_cable64_win10.cat'
$signature = Get-AuthenticodeSignature -LiteralPath $catalog
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '^CN=Microsoft Windows Hardware Compatibility Publisher,') { throw 'The VB-CABLE catalog must carry a valid Microsoft hardware publisher signature.' }
Copy-Item -LiteralPath (Join-Path $sourceRoot 'THIRD-PARTY-NOTICES.txt') -Destination $OutputDirectory
$licensePage = Join-Path $OutputDirectory 'vendor-license.html'
Copy-Item -LiteralPath (Join-Path $sourceRoot 'vendor-license.html') -Destination $licensePage
$vswhere = Join-Path "${env:ProgramFiles(x86)}" 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw 'Visual Studio C++ x64 build tools are required on the build machine.' }
$toolset = (Get-Content -LiteralPath (Join-Path $vsPath 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
$vcRoot = Join-Path $vsPath "VC/Tools/MSVC/$toolset"
$compiler = Join-Path $vcRoot 'bin/Hostx64/x64/cl.exe'
$sdkRoot = (Get-ItemProperty -LiteralPath 'HKLM:/SOFTWARE/Wow6432Node/Microsoft/Windows Kits/Installed Roots').KitsRoot10
$kitVersion = (Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um/windows.h') } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).Name
if (-not $kitVersion) { throw 'Windows SDK user-mode headers are required on the build machine.' }
$includeArgs = @("/I$vcRoot/include", "/I$sdkRoot/Include/$kitVersion/ucrt", "/I$sdkRoot/Include/$kitVersion/um", "/I$sdkRoot/Include/$kitVersion/shared", "/I$sdkRoot/Include/$kitVersion/winrt", "/I$OutputDirectory")
$libraries = @("/LIBPATH:$vcRoot/lib/x64", "/LIBPATH:$sdkRoot/Lib/$kitVersion/ucrt/x64", "/LIBPATH:$sdkRoot/Lib/$kitVersion/um/x64", 'ole32.lib', 'uuid.lib', 'setupapi.lib', 'newdev.lib', 'cfgmgr32.lib', 'advapi32.lib', 'wintrust.lib', 'crypt32.lib', 'shell32.lib')
$pinLines = @('#pragma once')
$pinLines += '#define DDTRANS_VENDOR_INF_HASH L"' + $vendor.files.'vbMmeCable64_win10.inf' + '"'
$pinLines += '#define DDTRANS_VENDOR_CAT_HASH L"' + $vendor.files.'vbaudio_cable64_win10.cat' + '"'
$pinLines += '#define DDTRANS_VENDOR_SYS_HASH L"' + $vendor.files.'vbaudio_cable64_win10.sys' + '"'
$pinLines += '#define DDTRANS_VENDOR_RENDER_CONNECTOR L"' + $vendor.connectors.render + '"'
$pinLines += '#define DDTRANS_VENDOR_CAPTURE_CONNECTOR L"' + $vendor.connectors.capture + '"'
$pinLines | Set-Content -LiteralPath (Join-Path $OutputDirectory 'vendor-pins.h') -Encoding utf8
foreach ($tool in @('device','probe')) {
    & $compiler /nologo /std:c++17 /EHsc /W4 /WX /MT /O2 /utf-8 /DUNICODE /D_UNICODE @includeArgs "/Fe$OutputDirectory/ddtrans-audio-$tool.exe" "/Fo$OutputDirectory/$tool.obj" (Join-Path $sourceRoot "$tool.cpp") /link @libraries /DYNAMICBASE /NXCOMPAT
    if ($LASTEXITCODE -ne 0) { throw "Native virtual audio tool compilation failed: $tool" }
}
$signtool = Join-Path $sdkRoot "bin/$kitVersion/x64/signtool.exe"
& $signtool verify /kp /c $catalog (Join-Path $vendorDirectory 'vbaudio_cable64_win10.sys')
if ($LASTEXITCODE -ne 0) { throw 'VB-CABLE kernel signing verification failed.' }
$hashes = [ordered]@{}
foreach ($file in Get-ChildItem -LiteralPath $OutputDirectory -File -Recurse | Where-Object { $_.Extension -notin @('.obj') -and $_.Name -notin @('manifest.json', 'vendor-pins.h') }) {
    $relative = [IO.Path]::GetRelativePath($OutputDirectory, $file.FullName).Replace('\','/')
    $hashes[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
}
[ordered]@{ provider='VB-Audio Software'; package=$vendor.version; source=$vendor.url; archiveSha256=$vendor.sha256; distributionTerms=$vendor.licenseUrl; catalogSigner=$signature.SignerCertificate.Subject; kernelSignatureVerified=$true; files=$hashes } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'manifest.json') -Encoding utf8
Write-Output "Prepared signed virtual audio payload: $OutputDirectory"
