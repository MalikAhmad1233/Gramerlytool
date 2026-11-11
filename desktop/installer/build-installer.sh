#!/usr/bin/env bash
# Builds WriteMind-Setup-<version>.exe with NSIS (makensis), on Linux or Windows (Git Bash).
#   desktop/installer/build-installer.sh <WriteMind.exe> <chrome-mv3 folder> <output.exe> [version]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exe="$(realpath "$1")"; ext="$(realpath "$2")"; out="$(realpath -m "$3")"; version="${4:-1.1.0}"
makensis=$(command -v makensis || echo "/c/Program Files (x86)/NSIS/makensis.exe")
# On Windows (Git Bash) makensis needs Windows-style paths.
native() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
cd "$here"
"$makensis" -V2 -DAPP_EXE="$(native "$exe")" -DEXT_DIR="$(native "$ext")" -DVERSION="$version" -DOUTFILE="$(native "$out")" WriteMind.nsi
ls -la "$out"
