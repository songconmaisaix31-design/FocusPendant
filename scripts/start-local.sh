#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
children=()
cleanup() {
  trap - INT TERM EXIT
  for pid in "${children[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${children[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup INT TERM EXIT
node core/server.mjs &
children+=("$!")
if [[ -x .venv-speech/bin/python ]]; then
  .venv-speech/bin/python speech/service.py &
  children+=("$!")
else
  echo '语音环境尚未准备：bash scripts/prepare-local-speech.sh'
fi
if [[ -x .venv-vision/bin/python ]]; then
  .venv-vision/bin/python collectors/vision_service.py &
  children+=("$!")
else
  echo '视觉环境尚未准备；可先使用计时、窗口记录与本地语音。详见 collectors/README.md。'
fi
echo '打开 http://localhost:7788；Ctrl+C 停止本次启动的服务。'
wait -n "${children[@]}"
