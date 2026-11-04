#!/usr/bin/env bash
# Regenerate the PWA / home-screen icon set from the SVGs in public/.
#
# Rasterises with headless Chrome (no ImageMagick / librsvg needed), then downsamples with sips.
# Run from the repo root: ./scripts/make-icons.sh
#
# Why this exists: the app icon is what iPhone shows when you "Add to Home Screen". A corrupt or
# mis-cropped PNG shows up as a blank tile, so the icons are generated in one place, at exact sizes,
# rather than hand-exported.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=public
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

CHROME=${CHROME:-}
if [ -z "$CHROME" ]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)" \
    "$(command -v chromium-browser || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && CHROME="$c" && break
  done
fi
[ -n "$CHROME" ] || { echo "No Chrome/Chromium found; set CHROME=/path/to/chrome" >&2; exit 1; }

# Render an SVG to a square PNG at 1024, then let sips do the (high-quality) downsamples.
render() { # $1 = svg, $2 = 1024 master png
  local svg="$1" master="$2" page="$TMP/page.html"
  cat > "$page" <<HTML
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
img{display:block;width:100vw;height:100vh}</style>
<img src="file://$(cd "$(dirname "$svg")" && pwd)/$(basename "$svg")">
HTML
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1024,1024 --screenshot="$master" "file://$page" >/dev/null 2>&1
  [ -s "$master" ] || { echo "render failed for $svg" >&2; exit 1; }
}

sized() { # $1 = master, $2 = size, $3 = out
  sips -z "$2" "$2" "$1" --out "$3" >/dev/null
}

render "$OUT/icon.svg"          "$TMP/any.png"
render "$OUT/icon-maskable.svg" "$TMP/maskable.png"

sized "$TMP/any.png" 512 "$OUT/icon-512.png"
sized "$TMP/any.png" 192 "$OUT/icon-192.png"
sized "$TMP/any.png" 180 "$OUT/apple-touch-icon.png"   # what iOS uses on the Home Screen
sized "$TMP/any.png" 167 "$OUT/apple-touch-icon-167.png" # older iPad Pro
sized "$TMP/any.png" 152 "$OUT/apple-touch-icon-152.png" # older iPad
sized "$TMP/any.png"  32 "$OUT/favicon-32.png"
sized "$TMP/maskable.png" 512 "$OUT/icon-maskable-512.png"

# iOS does not support transparency in home-screen icons: flatten to opaque RGB.
for f in "$OUT"/apple-touch-icon*.png; do
  sips -s format png --setProperty hasAlpha false "$f" --out "$f" >/dev/null 2>&1 || true
done

echo "icons written to $OUT/:"
ls -1 "$OUT"/apple-touch-icon*.png "$OUT"/icon-*.png "$OUT"/favicon-32.png | while read -r f; do
  printf '  %-34s %s\n' "$(basename "$f")" "$(sips -g pixelWidth -g pixelHeight "$f" | awk '/pixel/{printf "%s ", $2}')"
done
