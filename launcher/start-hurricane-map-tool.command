#!/bin/bash
# Opens the Hurricane Map Tool in your default browser, straight from disk.
# Works on macOS (open) and Linux (xdg-open). No install, no internet needed.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if command -v open >/dev/null 2>&1; then
  open "$DIR/index.html"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$DIR/index.html"
else
  echo "Open this file in your browser: $DIR/index.html"
fi
