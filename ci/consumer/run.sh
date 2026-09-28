#!/usr/bin/env bash
# Build the package exactly as users get it, install the tarball into an empty project (no dev
# dependencies), then run the ESM and CJS smoke tests. Run from the repository root.
# Set CEXY_LIVE_TESTS=1 to add one public time() call (never in CI).
set -euo pipefail
ROOT="$(pwd)"
VERSION="$(node -p "require('./package.json').version")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
npm run build
npm pack --pack-destination "$WORK" >/dev/null
TGZ="$(ls "$WORK"/*.tgz)"
mkdir "$WORK/app"
cd "$WORK/app"
npm init -y >/dev/null
npm install --no-audit --no-fund "$TGZ"
cp "$ROOT/ci/consumer/smoke.mjs" "$ROOT/ci/consumer/smoke.cjs" .
node smoke.mjs "$VERSION"
node smoke.cjs "$VERSION"
