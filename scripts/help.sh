#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec sh "$SCRIPT_DIR/deploy-package.sh" koishi-plugin-dongxuelian-help dongxuelian-help koishi-plugin-dongxuelian-help
