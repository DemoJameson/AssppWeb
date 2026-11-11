#!/usr/bin/env bash
# Builds the Anisette helper for a development instance.
#
# tools/anisette is its own Go module, and its module path sits under
# github.com/majd/ipatool/v2/ on purpose: the internal check in cmd/go compares
# the importing package's path, so that prefix is what lets this file import
# Apple's ADI/Store framework packages. The dependency comes from the module
# proxy at the version pinned in go.mod.
#
#   bash tools/anisette/build.sh
#
# The backend looks for the helper here by convention (services/anisette.ts
# tries the image's /opt/asspp/anisette, then this directory), so a development
# instance only has to restart it.
#
# The binary is gitignored. The helper downloads Apple's macOS 27 assets and the
# Unicorn runtime on its first run and caches them under the user cache
# directory; a release image prebakes the assets instead.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v go >/dev/null 2>&1; then
  echo "error: go is not on PATH (https://go.dev/dl)" >&2
  exit 1
fi

output="anisette"
case "$(go env GOOS)" in
  windows) output="anisette.exe" ;;
esac

cd "$HERE"
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$output" .

echo "built $HERE/$output"
echo "restart the backend; it finds the helper here by itself"
