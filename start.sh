#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node.js and npm first." >&2
  exit 1
fi

if [[ ! -d node_modules/electron ]]; then
  echo "Dependencies are missing. Run npm ci in this directory first." >&2
  exit 1
fi

exec node scripts/start.cjs "$@"
