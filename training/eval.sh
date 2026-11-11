#!/usr/bin/env bash
# Runs the WriteMind quality benchmarks against the built-in checker. See training/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p training/.build
NODE_PATH=extension/node_modules extension/node_modules/.bin/esbuild training/eval/run.ts --bundle --platform=node --format=esm --log-level=warning \
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" \
  --outfile=training/.build/eval.mjs
node training/.build/eval.mjs "$@"
