#!/usr/bin/env bash
#
# Development aid: builds the app with its web assets embedded, launches it,
# saves a PNG of its own window, and quits. See src-tauri/src/devtools.rs.
#
#   scripts/shot.sh out.png                       # default state
#   LUMEN_SHOT_EVAL="..." scripts/shot.sh out.png  # after running a script
#   SKIP_BUILD=1 scripts/shot.sh out.png           # reuse the last build

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?usage: scripts/shot.sh <out.png>}"
export PATH="$HOME/.cargo/bin:$PATH"

cd "$ROOT"
if [[ -z "${SKIP_BUILD:-}" ]]; then
  VITE_LUMEN_DEVTOOLS=1 pnpm build >/dev/null
  cargo build --quiet --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol
fi

# A private data directory, so a screenshot never reads or changes real settings.
DATA="${LUMEN_DATA_DIR:-$(mktemp -d -t lumen-shot)}"
LUMEN_DATA_DIR="$DATA" LUMEN_SHOT="$OUT" "$ROOT/src-tauri/target/debug/lumen"
