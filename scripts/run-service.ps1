$ErrorActionPreference = "Stop"

$projectDirectory = Split-Path -Parent $PSScriptRoot
$dataDirectory = Join-Path $projectDirectory "data"
$logPath = Join-Path $dataDirectory "service.log"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
Set-Location -LiteralPath $projectDirectory

& $nodePath (Join-Path $projectDirectory "server.js") *>> $logPath
exit $LASTEXITCODE
