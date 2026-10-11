param([int]$Port = 8765)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if (Test-Path -LiteralPath $bundledPython) {
    $pythonExecutable = $bundledPython
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $pythonExecutable = (Get-Command python).Source
} else {
    throw 'Python 3.10+ is required to serve this folder. Alternatively open index.html and select your workbook.'
}
Write-Host "PowerLog: http://127.0.0.1:$Port (Ctrl+C to stop)"
& $pythonExecutable -m http.server $Port --bind 127.0.0.1 --directory $projectRoot
