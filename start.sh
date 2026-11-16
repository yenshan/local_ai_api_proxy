#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

for tool in node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool was not found. Install Node.js and npm first." >&2
    exit 1
  fi
done

if ! npm ls --depth=0 --include=dev >/dev/null 2>&1; then
  echo "Installing application dependencies…"
  npm ci --include=dev
fi

exec node scripts/start.cjs "$@"
