#!/bin/bash
set -euo pipefail

# Resolve paths relative to this script, including when called from elsewhere.
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Build the Mac app on macOS." >&2
  exit 1
fi

for tool in node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool was not found. Install Node.js and npm first." >&2
    exit 1
  fi
done

APP_NAME="$(node -p 'require("./package.json").build.productName')"

case "$(node -p 'process.arch')" in
  arm64) APP_PATH="$PROJECT_DIR/dist/mac-arm64/${APP_NAME}.app" ;;
  x64) APP_PATH="$PROJECT_DIR/dist/mac/${APP_NAME}.app" ;;
  *) echo "Unsupported Node.js architecture." >&2; exit 1 ;;
esac

echo "[1/4] Preparing dependencies…"
npm ci --include=dev

echo "[2/4] Preparing Electron…"
# Recent Electron packages download their binary lazily on first require.
# Resolve it here so electron-builder can use electronDist without opening a GUI.
node -e 'console.log(require("electron"))'

echo "[3/4] Building the Mac app…"
npm run build

echo "[4/4] Verifying the app and local signature…"
if [[ ! -d "$APP_PATH" ]]; then
  echo "The built app was not found: $APP_PATH" >&2
  exit 1
fi
/usr/bin/codesign --verify --deep --strict "$APP_PATH"

printf '\nBuild complete:\n%s\n' "$APP_PATH"
