#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。Node.js と npm をインストールしてください。" >&2
  exit 1
fi

if [[ ! -d node_modules/electron ]]; then
  echo "依存パッケージがありません。このディレクトリで npm ci を実行してください。" >&2
  exit 1
fi

exec node scripts/start.cjs "$@"
