#!/usr/bin/env bash
# Build a minified copy of the extension under dist/ for Web Store packaging.
# Dev workflow is unchanged — load the repo root as unpacked. Run `npm run
# build` only when you want to test or ship the minified bundle.
#
# Per-file minification, not bundling: manifest.json's content_scripts.js
# array depends on the strict load order (lib/log.js first so AdnotaLog
# exists for every later script, etc.), and bundling into a single file
# would either require module wiring across ~15 scripts (which we don't
# have) or silently break that contract. So we minify each file in place
# and let the manifest's existing load order do its job.
#
# --keep-names preserves function/class names so error stacks stay readable
# and the cross-script handshake via window.AdnotaState / window.AdnotaUI
# etc. survives. Property-name mangling stays off (default) — payloads use
# stable field names that are referenced as strings in storage and JSON.

set -euo pipefail
cd "$(dirname "$0")/.."

DIST="dist"
WATCH_FLAG=""
if [[ "${1:-}" == "--watch" ]]; then
  WATCH_FLAG="--watch"
fi

# Kill any backgrounded esbuild children on exit so a failing one-shot job
# under `set -e` doesn't orphan the other, and so Ctrl-C during --watch
# tears down both watchers cleanly. `jobs -p` returns just our children,
# not the shell itself — avoids the self-SIGTERM `kill 0` would cause.
trap 'kill $(jobs -p) 2>/dev/null' EXIT

rm -rf "$DIST"
mkdir -p "$DIST"

# ─── JS ──────────────────────────────────────────────────────────────────────
# Glob expansion in bash gives us absolute-from-repo-root paths; --outbase=.
# tells esbuild to mirror that structure under dist/ (so content/eraser.js
# lands at dist/content/eraser.js, preserving every manifest path).
#
# Backgrounded because --watch blocks the foreground: in watch mode we need
# both JS and CSS watchers running concurrently. In one-shot mode it's also
# a small parallelism win. The EXIT trap above ensures a failing one-shot
# tears down the still-running sibling cleanly.
npx esbuild \
  background.js \
  content/*.js \
  lib/*.js \
  popup/*.js \
  pages/*.js \
  --minify \
  --keep-names \
  --target=chrome110 \
  --log-level=warning \
  --outbase=. \
  --outdir="$DIST" \
  $WATCH_FLAG &

# ─── CSS ─────────────────────────────────────────────────────────────────────
# esbuild's CSS minifier preserves --custom-property names by default; safe
# for our --adnota-* design token system. url() references are kept as-is
# (not bundled or resolved) because we're not bundling.
npx esbuild \
  lib/*.css \
  content/*.css \
  popup/*.css \
  pages/*.css \
  --minify \
  --log-level=warning \
  --outbase=. \
  --outdir="$DIST" \
  $WATCH_FLAG &

wait

# ─── Static assets ───────────────────────────────────────────────────────────
# Copied verbatim. manifest.json paths are relative to manifest, so the dist/
# tree resolves identically to the source tree once the binaries land.
cp manifest.json "$DIST/"
cp LICENSE "$DIST/"
cp -R icons "$DIST/"
mkdir -p "$DIST/lib"
cp -R lib/fonts "$DIST/lib/"
cp popup/index.html "$DIST/popup/"
cp pages/sites.html pages/welcome.html "$DIST/pages/"

# ─── Size report ─────────────────────────────────────────────────────────────
SRC_BYTES=$(find background.js content lib popup pages -type f \( -name '*.js' -o -name '*.css' \) -exec cat {} + | wc -c | tr -d ' ')
DIST_BYTES=$(find "$DIST" -type f \( -name '*.js' -o -name '*.css' \) -exec cat {} + | wc -c | tr -d ' ')
PCT=$(awk "BEGIN { printf \"%.1f\", ($DIST_BYTES / $SRC_BYTES) * 100 }")
echo ""
echo "Build complete → $DIST/"
echo "  JS+CSS source:    $(printf "%'d" $SRC_BYTES) bytes"
echo "  JS+CSS minified:  $(printf "%'d" $DIST_BYTES) bytes  (${PCT}% of source)"
