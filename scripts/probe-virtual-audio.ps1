param([string]$PayloadDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $PayloadDirectory) { $PayloadDirectory = Join-Path $projectRoot 'data/virtual-audio/build' }
$tool = Join-Path $PayloadDirectory 'ddtrans-audio-device.exe'
$probe = Join-Path $PayloadDirectory 'ddtrans-audio-probe.exe'
$status = & $tool status | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $status.ready) { throw 'The virtual audio device is not ready. Complete DDTrans installation, restart Windows if requested, and retry.' }
$renders = @($status.endpoints | Where-Object { $_.flow -eq 'render' -and $_.mainEndpoint -and $_.state -eq 1 })
$captures = @($status.endpoints | Where-Object { $_.flow -eq 'capture' -and $_.mainEndpoint -and $_.state -eq 1 })
if ($renders.Count -ne 1 -or $captures.Count -ne 1 -or $renders[0].adapterId -ne $captures[0].adapterId) { throw 'The render/capture pair cannot be uniquely identified. No audio was played.' }
$output = & $probe $renders[0].id $captures[0].id
$probeExit = $LASTEXITCODE
$output
$probeDirectory = Join-Path $projectRoot 'data/probes'
New-Item -ItemType Directory -Path $probeDirectory -Force | Out-Null
[ordered]@{ checkedAt=(Get-Date -Format o); endpoints=$status; audio=($output | ConvertFrom-Json); exitCode=$probeExit } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $probeDirectory 'bundled-virtual-audio-runtime.json') -Encoding utf8
exit $probeExit
