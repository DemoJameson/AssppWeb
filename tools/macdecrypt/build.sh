#!/usr/bin/env bash
# Builds the macOS package decrypter for a development instance.
#
# tools/macdecrypt is its own Go module, and its module path sits under
# github.com/majd/ipatool/v2/ on purpose: the internal check in cmd/go
# compares the importing package's path, so that prefix is what lets this
# file import the internal packages that drive Apple's StoreAgent, and the
# dependency itself comes from the module proxy at the version pinned in
# go.mod. No ipatool checkout to point at.
#
#   bash tools/macdecrypt/build.sh
#
# The backend looks for the helper here by convention (services/macDecrypt.ts
# tries the image's /opt/asspp/macdecrypt, then this directory), so a
# development instance only has to restart it — there is nothing to point at.
#
# On Windows without a bash shell, `build.ps1` is the native equivalent.
#
# The binary is gitignored; the build fetches the module tree through the
# proxy (the usual Go module cache), and the built helper downloads Apple's
# SAP assets and the Unicorn runtime on its first run and caches them under
# the user cache directory.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v go >/dev/null 2>&1; then
  echo "error: go is not on PATH (https://go.dev/dl)" >&2
  exit 1
fi

# The output name is relative, handed to `go` from inside this directory:
# an absolute MSYS path like /c/… would reach a Windows `go` verbatim (it
# once wrote to C:\c\…), and here the module directory is also where the
# binary belongs.
output="macdecrypt"
case "$(go env GOOS)" in
  windows) output="macdecrypt.exe" ;;
esac

cd "$HERE"
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$output" .

echo "built $HERE/$output"
echo "restart the backend; it finds the helper here by itself"
