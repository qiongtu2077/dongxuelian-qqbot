#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec sh "$SCRIPT_DIR/deploy-package.sh" koishi-plugin-dongxuelian-ai dongxuelian-ai koishi-plugin-dongxuelian-ai --copy-ai-skills
