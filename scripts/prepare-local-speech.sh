#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m venv .venv-speech
.venv-speech/bin/python -m pip install -r speech/requirements.txt
.venv-speech/bin/python speech/prepare_models.py "$@"
echo '本地语音模型已准备。运行 bash scripts/start-local.sh 启动。'
