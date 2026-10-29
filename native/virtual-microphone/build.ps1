param(
    [string]$WdkRoot,
    [string]$OutputDirectory,
    [switch]$TestOnly
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (-not $WdkRoot) { $WdkRoot = Join-Path $projectRoot 'data/driver-development/wdk/c' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'data/driver-development/build' }
$WdkRoot = (Resolve-Path -LiteralPath $WdkRoot).Path
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$vswhere = Join-Path "${env:ProgramFiles(x86)}" 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw 'Install Visual Studio C++ x64 tools before building.' }
$toolset = (Get-Content -LiteralPath (Join-Path $vsPath 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
$vcRoot = Join-Path $vsPath "VC/Tools/MSVC/$toolset"
$compiler = Join-Path $vcRoot 'bin/Hostx64/x64/cl.exe'
$linker = Join-Path $vcRoot 'bin/Hostx64/x64/link.exe'
$sdkRoot = (Get-ItemProperty 'HKLM:/SOFTWARE/Wow6432Node/Microsoft/Windows Kits/Installed Roots').KitsRoot10
$kitVersion = '10.0.26100.0'
$includeArgs = @(
    "/I$WdkRoot/Include/$kitVersion/km", "/I$WdkRoot/Include/$kitVersion/km/crt", "/I$vcRoot/include",
    "/I$sdkRoot/Include/$kitVersion/shared", "/I$sdkRoot/Include/$kitVersion/ucrt",
    "/I$WdkRoot/Include/wdf/kmdf/1.15"
)
$userIncludes = @("/I$vcRoot/include", "/I$sdkRoot/Include/$kitVersion/ucrt", "/I$sdkRoot/Include/$kitVersion/um", "/I$sdkRoot/Include/$kitVersion/shared")
$userLibraries = @("/LIBPATH:$vcRoot/lib/x64", "/LIBPATH:$sdkRoot/Lib/$kitVersion/ucrt/x64", "/LIBPATH:$sdkRoot/Lib/$kitVersion/um/x64")
& $compiler /nologo /std:c++17 /EHsc /W4 /WX /MT @userIncludes "/Fe$OutputDirectory/audio-ring-tests.exe" "/Fo$OutputDirectory/audio-ring-tests.obj" (Join-Path $PSScriptRoot 'tests/audio-ring-tests.cpp') /link @userLibraries
if ($LASTEXITCODE -ne 0) { throw 'Audio bridge test compilation failed.' }
& (Join-Path $OutputDirectory 'audio-ring-tests.exe')
if ($LASTEXITCODE -ne 0) { throw 'Audio bridge tests failed.' }
if ($TestOnly) { return }
foreach ($tool in @('device-tool','probe')) {
    & $compiler /nologo /std:c++17 /EHsc /W4 /WX /MT /DUNICODE /D_UNICODE @userIncludes "/Fe$OutputDirectory/ddtrans-$tool.exe" "/Fo$OutputDirectory/$tool.obj" (Join-Path $PSScriptRoot "$tool.cpp") /link @userLibraries ole32.lib uuid.lib setupapi.lib newdev.lib cfgmgr32.lib ksuser.lib advapi32.lib
    if ($LASTEXITCODE -ne 0) { throw "Native tool compilation failed: $tool" }
}
$sourceRoot = Join-Path $PSScriptRoot 'driver/Source'
$includeArgs += @('Inc','Main','Filters','Utilities') | ForEach-Object { "/I$sourceRoot/$_" }
$sourceFiles = Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'Main'),(Join-Path $sourceRoot 'Filters'),(Join-Path $sourceRoot 'Utilities') -Filter '*.cpp'
$compileArgs = @('/nologo','/c','/kernel','/std:c++17','/W4','/WX','/wd4324','/GS','/guard:cf','/GR-','/EHs-c-','/Zl','/O2','/Zc:wchar_t-',
    '/D_AMD64_','/DAMD64','/D_WIN64','/D_WIN32','/DWINNT','/DNTDDI_VERSION=0x0A00000C','/D_WIN32_WINNT=0x0A00',
    '/DUNICODE','/D_UNICODE','/DPC_IMPLEMENTATION','/D_USE_WAVERT_','/D_USE_IPortClsRuntimePower','/D_NEW_DELETE_OPERATORS_','/DDEBUG_LEVEL=1')
foreach ($source in $sourceFiles) {
    & $compiler @compileArgs @includeArgs "/Fo$OutputDirectory/$($source.BaseName).obj" $source.FullName
    if ($LASTEXITCODE -ne 0) { throw "Driver compile failed: $($source.Name)" }
}
$objects = $sourceFiles | ForEach-Object { Join-Path $OutputDirectory "$($_.BaseName).obj" }
& $linker /nologo /driver /subsystem:native,10.00 /entry:FxDriverEntry /NODEFAULTLIB /INTEGRITYCHECK /DYNAMICBASE /NXCOMPAT /guard:cf /MACHINE:X64 /OPT:REF,ICF "/OUT:$OutputDirectory/DDTransVirtualAudio.sys" "/LIBPATH:$WdkRoot/Lib/$kitVersion/km/x64" "/LIBPATH:$WdkRoot/Lib/wdf/kmdf/x64/1.15" "/LIBPATH:$vcRoot/lib/x64" @objects portcls.lib stdunk.lib libcntpr.lib ntoskrnl.lib hal.lib BufferOverflowFastFailK.lib WdfDriverEntry.lib WdfLdr.lib ksguid.lib drmk.lib
if ($LASTEXITCODE -ne 0) { throw 'Driver link failed.' }
Write-Output "Driver built: $OutputDirectory/DDTransVirtualAudio.sys"

$packageDirectory = Join-Path $OutputDirectory 'package'
New-Item -ItemType Directory -Path $packageDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'DDTransVirtualAudio.inf') -Destination $packageDirectory
Copy-Item -LiteralPath (Join-Path $OutputDirectory 'DDTransVirtualAudio.sys') -Destination $packageDirectory
& (Join-Path $WdkRoot "tools/$kitVersion/x64/infverif.exe") /w (Join-Path $packageDirectory 'DDTransVirtualAudio.inf')
if ($LASTEXITCODE -ne 0) { throw 'Driver INF validation failed.' }
& (Join-Path $WdkRoot "bin/$kitVersion/x86/Inf2Cat.exe") "/driver:$packageDirectory" /os:10_CO_X64,10_NI_X64,10_GE_X64
if ($LASTEXITCODE -ne 0) { throw 'Driver catalog generation failed.' }
Write-Output "Unsigned development package: $packageDirectory"
