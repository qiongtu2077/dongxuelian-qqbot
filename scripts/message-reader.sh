#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
echo "message-reader.js is part of dongxuelian-ai; deploying the full AI package."
exec sh "$SCRIPT_DIR/ai.sh"
