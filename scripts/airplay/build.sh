#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
build="$root/vendor/build/airplay"
mkdir -p "$build" "$root/vendor/bin"
uv venv --allow-existing --python 3.12 "$build/venv"
uv pip install --python "$build/venv/bin/python" \
  'pyatv @ git+https://github.com/robkochman/pyatv.git@8144c77c6cecbed4f9ba2adb5a350ad86a8f6604' \
  'srptools==1.0.1' 'pyinstaller==6.22.3'
"$build/venv/bin/pyinstaller" --noconfirm --onefile --name lumen-airplay \
  --collect-submodules pyatv.protocols --copy-metadata pyatv \
  --distpath "$root/vendor/bin" --specpath "$build" --workpath "$build/cache" \
  "$root/scripts/airplay/sender.py"
