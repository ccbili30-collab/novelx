$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$appRoot = Split-Path -Parent $PSScriptRoot
Push-Location $appRoot
try {
  & npm.cmd run build:decomposer-prompt-eval
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & node .\test-results\decomposer-prompt-eval-runner\decomposer-prompt-eval-runner.js
  exit $LASTEXITCODE
} finally { Pop-Location }
