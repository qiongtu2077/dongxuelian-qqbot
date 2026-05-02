#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec sh "$SCRIPT_DIR/deploy-package.sh" koishi-plugin-group-leave-notice group-leave-notice koishi-plugin-group-leave-notice
