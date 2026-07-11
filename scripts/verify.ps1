[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$appRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Resolve-Path (Join-Path $appRoot "..\..")

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command
  )

  Write-Host "`n== $Label =="
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

Push-Location $appRoot
try {
  Invoke-CheckedCommand "TypeScript typecheck" { npm.cmd run typecheck }
  Invoke-CheckedCommand "Unit and integration tests" { npm.cmd test }
  Invoke-CheckedCommand "Production build" { npm.cmd run build }
  Invoke-CheckedCommand "Electron end-to-end tests" { npm.cmd run test:e2e }
} finally {
  Pop-Location
}

Push-Location $repoRoot
try {
  Invoke-CheckedCommand "Desktop diff whitespace check" { git diff --check -- desktop }
} finally {
  Pop-Location
}

Write-Host "`nnovelx Desktop verification passed."
