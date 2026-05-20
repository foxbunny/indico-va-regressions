#!/bin/bash
# Runner container entrypoint. Symlinks node_modules from the image-baked
# location into the bind-mounted runner dir so the host doesn't need to
# `npm install` and the bind mount doesn't shadow the deps.

set -euo pipefail

# Always (re)point node_modules at the image-baked tree. If a host
# `npm install` left a node_modules behind, it might be compiled for a
# different Node version and would cause ABI mismatches.
rm -rf /regressions/runner/node_modules
ln -s "${RUNNER_NODE_MODULES}" /regressions/runner/node_modules

cd /regressions/runner
exec npx tsx runner.ts \
  --base-url "${BASE_URL:-http://indico:8000}" \
  --frozen "${FROZEN_TIME:-2026-06-15T12:00:00+00:00}" \
  "$@"
