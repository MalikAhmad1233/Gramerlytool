#!/usr/bin/env bash
# Runs a local LanguageTool HTTP server (default port 8081).
set -euo pipefail
PORT="${LT_PORT:-8081}"
HEAP="${LT_HEAP:-1g}"
cd "$(dirname "$0")/../infra/languagetool"
[ -d lib ] || ../../scripts/fetch-languagetool.sh
exec java -Xms256m -Xmx"$HEAP" -cp "lib/*" org.languagetool.server.HTTPServer \
  --port "$PORT" --public --allow-origin "*" --config server.properties
