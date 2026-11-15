#!/bin/bash
set -euo pipefail

# Resolve paths relative to this script, including when called from elsewhere.
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Mac アプリのビルドは macOS で実行してください。" >&2
  exit 1
fi

for tool in node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool が見つかりません。Node.js と npm をインストールしてください。" >&2
    exit 1
  fi
done

APP_NAME="$(node -p 'require("./package.json").build.productName')"

case "$(node -p 'process.arch')" in
  arm64) APP_PATH="$PROJECT_DIR/dist/mac-arm64/${APP_NAME}.app" ;;
  x64) APP_PATH="$PROJECT_DIR/dist/mac/${APP_NAME}.app" ;;
  *) echo "未対応の Node.js アーキテクチャです。" >&2; exit 1 ;;
esac

echo "[1/4] 依存パッケージを準備しています…"
npm ci --include=dev

echo "[2/4] Electron バイナリを準備しています…"
# Recent Electron packages download their binary lazily on first require.
# Resolve it here so electron-builder can use electronDist without opening a GUI.
node -e 'console.log(require("electron"))'

echo "[3/4] Mac アプリをビルドしています…"
npm run build

echo "[4/4] アプリとローカル署名を確認しています…"
if [[ ! -d "$APP_PATH" ]]; then
  echo "ビルドしたアプリが見つかりません: $APP_PATH" >&2
  exit 1
fi
/usr/bin/codesign --verify --deep --strict "$APP_PATH"

printf '\nビルド完了:\n%s\n' "$APP_PATH"
