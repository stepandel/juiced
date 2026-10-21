#!/bin/sh
set -eu
# Resolve the installer-created symlink without requiring readlink -f on macOS.
entry=$0
while [ -L "$entry" ]; do
  parent=$(CDPATH= cd -P "$(dirname "$entry")" && pwd)
  entry=$(readlink "$entry")
  case "$entry" in /*) ;; *) entry=$parent/$entry ;; esac
done
root=$(CDPATH= cd -P "$(dirname "$entry")/.." && pwd)
exec "$root/lib/node" "$root/bin/juiced.mjs" "$@"
