#!/usr/bin/env bash
# Bake icons/icon-{16,32,48,128}.png from icons/favicon.svg.
# Re-run after editing the SVG. The PNGs ship in the manifest because
# Chrome MV3 requires raster icons for the toolbar / extensions menu.
set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ICONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/icons"
SVG="$ICONS_DIR/favicon.svg"

[ -f "$SVG" ] || { echo "missing $SVG"; exit 1; }
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME"; exit 1; }

cd "$ICONS_DIR"
for size in 16 32 48 128; do
  cat > /tmp/adnota-icon-wrap.html <<EOF
<!DOCTYPE html><html><head>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@900&display=block" rel="stylesheet">
<style>html,body{margin:0;padding:0;background:transparent;}svg{display:block;width:${size}px;height:${size}px;}</style>
</head><body>$(cat "$SVG")</body></html>
EOF
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --virtual-time-budget=5000 \
    --default-background-color=00000000 \
    --screenshot="icon-${size}.png" \
    --window-size="${size},${size}" \
    "file:///tmp/adnota-icon-wrap.html" >/dev/null 2>&1
  echo "rendered icon-${size}.png"
done
rm -f /tmp/adnota-icon-wrap.html
