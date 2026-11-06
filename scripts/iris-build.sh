#!/usr/bin/env bash
set -euo pipefail
project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
kit_root=${1:-${IRISVIEW_KIT:-}}
if [[ -z "$kit_root" || ! -x "$kit_root/bin/irisview" ]]; then
  echo 'Usage: bash scripts/iris-build.sh /absolute/path/IrisView-Developer-Kit-v1.0.0' >&2
  exit 2
fi
kit_root=$(cd "$kit_root" && pwd)

# The SDK requires the exact 24.13.0 parser. On x86_64 Linux, its bundled
# runtime provides it; assemble a temporary toolchain without modifying Kit.
if [[ $(node --version 2>/dev/null || true) != v24.13.0 ]]; then
  build_tools=$(mktemp -d)
  trap 'rm -rf "$build_tools"' EXIT
  mkdir -p "$build_tools/bin/x86_64" "$build_tools/lib/x86_64"
  cp "$kit_root/runtime/runtime/bin/x86_64/irisnode" "$build_tools/bin/x86_64/node"
  cp "$kit_root/runtime/runtime/lib/x86_64/libnode.so.137" "$build_tools/lib/x86_64/"
  for destination in "$build_tools/bin/x86_64" "$build_tools/lib/x86_64"; do
    cp "$kit_root/runtime/lib/libc++.so.1" "$kit_root/runtime/lib/libc++abi.so.1" "$kit_root/runtime/lib/libunwind.so.1" "$destination/"
  done
  export PATH="$build_tools/bin/x86_64:$PATH"
fi

app_root="$project_root/iris-app"
package_file="$app_root/FocusPendant-1.0.0.fuiapp"
"$kit_root/bin/irisview" test "$app_root"
"$kit_root/bin/irisview" build "$app_root"
if [[ -n ${IRIS_SOURCE_REVISION:-} ]]; then
  "$kit_root/bin/irisview" package "$app_root" --output "$package_file" --debug-unsigned --profile diagnostic --source-revision "$IRIS_SOURCE_REVISION" --source-state dirty
elif git -C "$app_root" rev-parse --verify HEAD >/dev/null 2>&1; then
  "$kit_root/bin/irisview" package "$app_root" --output "$package_file" --debug-unsigned --profile diagnostic
else
  revision=$(cat "$app_root/SOURCE_REVISION")
  "$kit_root/bin/irisview" package "$app_root" --output "$package_file" --debug-unsigned --profile diagnostic --source-revision "$revision" --source-state dirty
fi
"$kit_root/bin/irisview" verify "$package_file" --allow-debug-unsigned
