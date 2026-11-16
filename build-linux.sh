#!/bin/bash
set -euo pipefail

# Resolve paths relative to this script, including when called from elsewhere.
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Build the Linux app on Linux." >&2
  exit 1
fi

for tool in node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool was not found. Install Node.js and npm first." >&2
    exit 1
  fi
done

case "$(node -p 'process.arch')" in
  x64) APP_DIR="$PROJECT_DIR/dist/linux-unpacked" ;;
  arm64) APP_DIR="$PROJECT_DIR/dist/linux-arm64-unpacked" ;;
  *) echo "Unsupported Node.js architecture." >&2; exit 1 ;;
esac
APP_PATH="$APP_DIR/$(node -p 'require("./package.json").build.linux.executableName')"

echo "[1/4] Preparing dependencies…"
npm ci --include=dev

echo "[2/4] Preparing Electron…"
# Resolve the Electron binary before electron-builder uses electronDist.
node -e 'console.log(require("electron"))'

echo "[3/4] Building the Linux app…"
npm run build:linux

echo "[4/4] Verifying the app…"
if [[ ! -x "$APP_PATH" || ! -f "$APP_DIR/resources/app.asar" ]]; then
  echo "The built app is missing or incomplete: $APP_PATH" >&2
  exit 1
fi

printf '\nBuild complete:\n%s\n\nRun the app:\n"%s"\n' "$APP_DIR" "$APP_PATH"
