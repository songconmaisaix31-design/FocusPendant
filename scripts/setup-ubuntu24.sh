#!/usr/bin/env bash
# Install runtime prerequisites on the user's Ubuntu 24.04 workstation.
set -euo pipefail
action=${1:---check}
if [[ "$action" != --check && "$action" != --install ]]; then
  echo 'Usage: bash scripts/setup-ubuntu24.sh [--check|--install]' >&2
  exit 2
fi
source /etc/os-release
if [[ "${ID:-}:${VERSION_ID:-}" != ubuntu:24.04 || $(uname -m) != x86_64 ]]; then
  echo 'This helper targets Ubuntu 24.04 x86_64.' >&2
  exit 2
fi
packages=(python3 python3-venv python3-pip git binutils libegl1 libgles2 libx11-6 libxext6
  libatk1.0-0t64 libatomic1 libbrotli1 libbz2-1.0 libcairo2 libfontconfig1
  libgdk-pixbuf-2.0-0 libglib2.0-0t64 libgtk-3-0t64 libharfbuzz0b
  libmpg123-0t64 libpango-1.0-0 libpangocairo-1.0-0 libpng16-16t64
  libstdc++6 zlib1g pulseaudio-utils ffmpeg xvfb xauth x11-xkb-utils)
missing=()
for pkg in "${packages[@]}"; do
  if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q '^install ok installed$'; then missing+=("$pkg"); fi
done
if ((${#missing[@]}==0)); then
  echo 'Ubuntu 24.04 runtime prerequisites already installed.'
else
  printf 'Missing packages: %s\n' "${missing[*]}"
  if [[ "$action" == --install ]]; then
    plan=$(LC_ALL=C apt-get -s install --no-install-recommends --no-remove --no-upgrade -- "${missing[@]}")
    if grep -qE '^Remv |^The following packages will be DOWNGRADED:' <<<"$plan"; then
      echo 'Dependency plan would remove or downgrade existing packages; no changes made.' >&2
      exit 1
    fi
    if [[ $(id -u) == 0 ]]; then admin=(); else admin=(sudo); fi
    "${admin[@]}" apt-get install -y --no-install-recommends --no-remove --no-upgrade -- "${missing[@]}"
  else
    echo 'Install these prerequisites: bash scripts/setup-ubuntu24.sh --install'
  fi
fi
if [[ -z ${DISPLAY:-} ]]; then echo 'DISPLAY is unset. For normal use, start a desktop X session or WSLg.'; fi
echo 'Run: bash scripts/iris-run.sh /absolute/path/IrisView-Developer-Kit-v1.0.0'
