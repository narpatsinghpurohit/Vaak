#!/usr/bin/env bash
# Build and package Vaak as a macOS DMG.
#
# Cleans all prior build outputs first to prevent electron-builder from
# re-packing stale DMGs or .app bundles into the new one (which would
# double the DMG size each release).
#
# Usage: npm run package  (or: bash scripts/package.sh)

set -euo pipefail

cd "$(dirname "$0")/.."

say() { printf "\n\033[1;36m→ %s\033[0m\n" "$1"; }
ok()  { printf "\033[1;32m✓\033[0m %s\n" "$1"; }
die() { printf "\033[1;31m✗\033[0m %s\n" "$1" >&2; exit 1; }

say "cleaning build outputs (dist/, out/, release/)"
rm -rf dist out release
ok "cleaned"

say "compiling main + preload (tsc)"
npx tsc -p tsconfig.main.json

say "bundling renderer (vite)"
npx vite build --config vite.config.ts

say "packaging .dmg (electron-builder)"
npx electron-builder --mac --config

DMG=$(ls -1 dist/*.dmg 2>/dev/null | head -1 || true)
[ -n "${DMG:-}" ] || die "no DMG produced in dist/"

SIZE_BYTES=$(stat -f%z "$DMG")
SIZE_HUMAN=$(du -h "$DMG" | cut -f1)
VERSION=$(node -p "require('./package.json').version")

echo ""
ok "built $DMG ($SIZE_HUMAN)"
echo ""
echo "  version:  $VERSION"
echo "  size:     $SIZE_BYTES bytes"

# Guardrail: a clean Vaak DMG is ~120 MB. Anything over 500 MB almost
# certainly means a stale artifact was packed in (previous DMG or .app
# bundle). Fail loudly so it can't slip into a release.
MAX_BYTES=$((500 * 1024 * 1024))
if [ "$SIZE_BYTES" -gt "$MAX_BYTES" ]; then
  echo ""
  die "DMG is ${SIZE_HUMAN} — over 500 MB guardrail. Clean dist/ and check the 'files' glob in package.json."
fi
