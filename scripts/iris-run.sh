#!/usr/bin/env bash
set -euo pipefail
project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ -z ${FOCUS_TOKEN:-} && -z ${FOCUS_DEVICE_TOKEN:-} ]]; then
  FOCUS_TOKEN=$(node "$project_root/scripts/owner-token.mjs")
  if [[ -n "$FOCUS_TOKEN" ]]; then export FOCUS_TOKEN; else unset FOCUS_TOKEN; fi
fi
kit_root=${1:-${IRISVIEW_KIT:-}}
if [[ -z "$kit_root" || ! -x "$kit_root/bin/irisview" ]]; then
  echo 'Usage: bash scripts/iris-run.sh /absolute/path/IrisView-Developer-Kit-v1.0.0' >&2
  exit 2
fi
kit_root=$(cd "$kit_root" && pwd)
shift || true
runner=("$kit_root/bin/irisview")
if [[ " ${*:-} " != *' --dry-run '* ]]; then
  "${runner[@]}" doctor --runtime-only --profile diagnostic
fi
exec "${runner[@]}" run "$project_root/iris-app/FocusPendant-1.0.0.fuiapp" --profile diagnostic --allow-debug-unsigned --audio-mode "${IRIS_AUDIO_MODE:-desktop}" "$@"
