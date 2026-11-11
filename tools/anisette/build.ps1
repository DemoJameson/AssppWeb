# Builds the Anisette helper on Windows, without needing a bash shell.
#
# This directory is its own Go module, and its module path sits under
# github.com/majd/ipatool/v2/ on purpose: the internal check in cmd/go compares
# the importing package's path, so that prefix is what lets server.go import
# Apple's ADI/Store framework packages. `build.sh` is the same flow for POSIX
# shells.
#
#   powershell -File tools\anisette\build.ps1
#
# The backend looks for the helper here by convention (services/anisette.ts
# tries the image's /opt/asspp/anisette, then this directory).
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $PSCommandPath

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  Write-Error "error: go is not on PATH (https://go.dev/dl)"
}

$output = "anisette"
if ((go env GOOS).Trim() -eq "windows") { $output += ".exe" }

$env:CGO_ENABLED = "0"
Push-Location $here
try {
  go build -trimpath -ldflags "-s -w" -o $output .
  if ($LASTEXITCODE -ne 0) {
    Write-Error "error: go build failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

Write-Host "built $(Join-Path $here $output)"
Write-Host "restart the backend; it finds the helper here by itself"
