#!/bin/sh
set -eu

APP_DIR="${KOISHI_APP_DIR:-${KOISHI_DIR:-/root/koishi-app}}"
APP_DIR="$(cd "$APP_DIR" && pwd -P)"

DATA_DIR="${DONGXUELIAN_AI_DATA_DIR:-${DATA_DIR:-$APP_DIR/data}}"
case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR="$APP_DIR/$DATA_DIR" ;;
esac
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd -P)"

case "$APP_DIR" in
  ""|"/") echo "Refusing unsafe APP_DIR: $APP_DIR" >&2; exit 1 ;;
esac

EXPECTED_DATA_DIR="$APP_DIR/data"
if [ "$DATA_DIR" != "$EXPECTED_DATA_DIR" ]; then
  echo "Refusing to seal package data into non-root data dir: $DATA_DIR" >&2
  echo "Expected: $EXPECTED_DATA_DIR" >&2
  exit 1
fi

BACKUP_ROOT="${DATA_SEAL_BACKUP_ROOT:-$APP_DIR/deploy-backups}"
STAMP="${DATA_SEAL_STAMP:-$(date +%Y%m%d-%H%M%S)}"
BACKUP_DIR="$BACKUP_ROOT/data-seal-$STAMP"

copy_seed_path() {
  rel="$1"
  seed="$2"
  case "$seed" in
    ""|/*|*"/../"*|"../"*|*".."*)
      echo "Refusing unsafe seed path: $rel/$seed" >&2
      exit 1
      ;;
  esac

  case "$seed" in
    ai-paused.txt|ai-provider.txt|ai-model.txt|ai-base-url.txt|ai-enable-search.txt|ai-enable-thinking.txt|ai-*key*.txt|dashboard-*.txt|password-reset-token.txt)
      echo "skip runtime data seed: $rel/$seed"
      return 0
      ;;
  esac

  src="$APP_DIR/$rel/$seed"
  dst="$DATA_DIR/$seed"
  if [ ! -e "$src" ]; then
    echo "package data seed path absent: $rel/$seed"
    return 0
  fi
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    cp -an "$src/." "$dst/" 2>/dev/null || true
  else
    mkdir -p "$(dirname "$dst")"
    if [ ! -e "$dst" ]; then
      cp "$src" "$dst"
    fi
  fi
  echo "merged package data seed path: $rel/$seed -> $dst"
}

merge_seed_one() {
  rel="$1"
  shift || true
  pkg_data="$APP_DIR/$rel"
  parent="$(dirname "$pkg_data")"
  mkdir -p "$parent"

  if [ -L "$pkg_data" ]; then
    target="$(readlink -f "$pkg_data" 2>/dev/null || true)"
    if [ "$target" = "$DATA_DIR" ]; then
      echo "legacy package data symlink already points to runtime data: $rel -> $DATA_DIR"
      return 0
    fi
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    mv "$pkg_data" "$BACKUP_DIR/$rel.wrong-symlink"
    mkdir -p "$pkg_data"
    echo "archived wrong package data symlink: $rel"
  elif [ -d "$pkg_data" ]; then
    real_pkg="$(cd "$pkg_data" && pwd -P)"
    if [ "$real_pkg" = "$DATA_DIR" ]; then
      echo "package data already resolves to runtime data: $rel -> $DATA_DIR"
      return 0
    fi
    if [ "$#" -eq 0 ]; then
      echo "no package data seed allowlist: $rel"
      return 0
    fi
    for seed in "$@"; do
      copy_seed_path "$rel" "$seed"
    done
    echo "checked package data seed allowlist without mutating source: $rel -> $DATA_DIR"
  elif [ -e "$pkg_data" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    mv "$pkg_data" "$BACKUP_DIR/$rel.non-directory"
    mkdir -p "$pkg_data"
    echo "archived non-directory package data path: $rel"
  else
    echo "package data seed absent: $rel"
  fi
}

merge_seed_one "packages/koishi-plugin-dongxuelian-ai/data" "ai-skills" "ai-tool-config.json" "summary-whitelist.json"
merge_seed_one "packages/koishi-plugin-group-name-at/data"
merge_seed_one "packages/koishi-plugin-local-video-sender/data"

if [ -e "$DATA_DIR/data" ] || [ -L "$DATA_DIR/data" ]; then
  nested="$DATA_DIR/data"
  nested_real="$(readlink -f "$nested" 2>/dev/null || true)"
  if [ "$nested_real" != "$DATA_DIR" ]; then
    mkdir -p "$BACKUP_DIR/root"
    mv "$nested" "$BACKUP_DIR/root/nested-data"
    cp -an "$BACKUP_DIR/root/nested-data/." "$DATA_DIR/" 2>/dev/null || true
    echo "merged and archived nested root data: $BACKUP_DIR/root/nested-data"
  fi
fi

echo "runtime data dir sealed: $DATA_DIR"
