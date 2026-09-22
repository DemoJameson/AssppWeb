# Builds the macOS package decrypter on Windows, without needing a bash shell.
#
# This directory is its own Go module, and its module path sits under
# github.com/majd/ipatool/v2/ on purpose: the internal check in cmd/go
# compares the importing package's path, so that prefix is what lets main.go
# import the internal packages that drive Apple's StoreAgent, and the
# dependency itself comes from the module proxy at the version pinned in
# go.mod. No ipatool checkout to point at. `build.sh` is the same flow for
# POSIX shells.
#
#   powershell -File tools\macdecrypt\build.ps1
#
# The backend looks for the helper here by convention (services/macDecrypt.ts
# tries the image's /opt/asspp/macdecrypt, then this directory), so a
# development instance only has to restart it — there is nothing to point at.
#
# The binary is gitignored; the build fetches the module tree through the
# proxy (the usual Go module cache), and the built helper downloads Apple's
# SAP assets and the Unicorn runtime on its first run and caches them under
# the user cache directory.
$ErrorActionPreference = "Stop"

# The module directory is also where the binary belongs.
$here = Split-Path -Parent $PSCommandPath

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  Write-Error "error: go is not on PATH (https://go.dev/dl)"
}

# The output name is relative: `go build -o` does not append `.exe` on
# Windows, so the name carries it, and building from inside the module keeps
# the path free of anything an MSYS-style translation could chew on.
$output = "macdecrypt"
if ((go env GOOS).Trim() -eq "windows") { $output += ".exe" }

$env:CGO_ENABLED = "0"
Push-Location $here
try {
  go build -trimpath -ldflags "-s -w" -o $output .
  # A native command's exit code does not raise: without this check a failed
  # build falls through to the success line below, and a binary left by an
  # earlier run would be reported as freshly built.
  if ($LASTEXITCODE -ne 0) {
    Write-Error "error: go build failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$full = Join-Path $here $output
Write-Host "built $full"
Write-Host "restart the backend; it finds the helper here by itself"
