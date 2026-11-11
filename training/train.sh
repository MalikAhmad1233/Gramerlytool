#!/usr/bin/env bash
# Trains shared/model/en.model.txt from the datasets in training/.data (see training/README.md).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p training/.build
NODE_PATH=extension/node_modules extension/node_modules/.bin/esbuild training/train/train.ts --bundle --platform=node --format=esm --log-level=warning \
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" \
  --outfile=training/.build/train.mjs
node --max-old-space-size=4096 training/.build/train.mjs "$@"
