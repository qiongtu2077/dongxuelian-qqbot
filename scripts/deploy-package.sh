#!/usr/bin/env sh
set -eu

PACKAGE_DIR="${1:-}"
KOISHI_KEY="${2:-}"
ALIASES="${3:-}"
COPY_AI_SKILLS="${4:-}"

if [ -z "$PACKAGE_DIR" ] || [ -z "$KOISHI_KEY" ]; then
  echo "usage: deploy-package.sh <package-dir> <koishi-key> [aliases-csv] [--copy-ai-skills]" >&2
  exit 2
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DEFAULT_APP_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)"
APP_DIR="${KOISHI_APP_DIR:-${KOISHI_DIR:-$DEFAULT_APP_DIR}}"
KOISHI_YML="${KOISHI_YML:-$APP_DIR/koishi.yml}"
NODE_MODULES_DIR="$APP_DIR/node_modules"
if [ -d "$SCRIPT_DIR/../packages" ]; then
  REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
elif [ -d "./packages" ]; then
  REPO_ROOT="$(pwd)"
elif [ -d "../packages" ]; then
  REPO_ROOT="$(CDPATH= cd -- ".." && pwd)"
else
  echo "Cannot find repository root with packages/." >&2
  echo "Run this script from the repo root or from scripts/." >&2
  exit 1
fi

SRC="$REPO_ROOT/packages/$PACKAGE_DIR"
if [ ! -d "$SRC/lib" ] || [ ! -f "$SRC/package.json" ]; then
  echo "Package source is incomplete: $SRC" >&2
  exit 1
fi

PACKAGE_NAME="$(node -e "const p=require(process.argv[1]); if(!p.name) process.exit(1); console.log(p.name)" "$SRC/package.json")"
PACKAGE_VERSION="$(node -e "const p=require(process.argv[1]); console.log(p.version || '0.0.0')" "$SRC/package.json")"
DEST="$NODE_MODULES_DIR/$PACKAGE_NAME"

mkdir -p "$NODE_MODULES_DIR"
case "$DEST" in
  "$NODE_MODULES_DIR"/*) rm -rf "$DEST" ;;
  *) echo "Refusing to remove unsafe destination: $DEST" >&2; exit 1 ;;
esac

mkdir -p "$DEST"
cp "$SRC/package.json" "$DEST/package.json"
cp -R "$SRC/lib" "$DEST/lib"
if [ -d "$SRC/assets" ]; then
  cp -R "$SRC/assets" "$DEST/assets"
fi
if [ -d "$SRC/data" ]; then
  cp -R "$SRC/data" "$DEST/data"
fi
if [ -d "$SRC/templates" ]; then
  cp -R "$SRC/templates" "$DEST/templates"
fi

if [ "$COPY_AI_SKILLS" = "--copy-ai-skills" ]; then
  mkdir -p "$APP_DIR/data/ai-skills"
  chmod 700 "$APP_DIR/data" 2>/dev/null || true
  if [ -d "$SRC/data/ai-skills" ]; then
    (cd "$SRC/data/ai-skills" && find . -type d -exec mkdir -p "$APP_DIR/data/ai-skills/{}" \;)
    (cd "$SRC/data/ai-skills" && find . -type f | while IFS= read -r rel; do
      target="$APP_DIR/data/ai-skills/$rel"
      if [ ! -e "$target" ]; then
        mkdir -p "$(dirname "$target")"
        cp "$SRC/data/ai-skills/$rel" "$target"
      fi
    done)
  fi
fi

for js_file in "$DEST"/lib/*.js; do
  [ -f "$js_file" ] || continue
  node -c "$js_file"
done

node - "$KOISHI_YML" "$KOISHI_KEY" "$ALIASES" <<'NODE'
const fs = require('fs')
const [configPath, desiredKey, aliasesCsv = ''] = process.argv.slice(2)
const keys = [desiredKey, ...aliasesCsv.split(',').map(s => s.trim()).filter(Boolean)]
const uniqueKeys = [...new Set(keys)]
const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const keyRegexes = uniqueKeys.map(key => ({ key, re: new RegExp(`^(\\s*)${escapeRe(key)}(?::[a-z0-9]+)?\\s*:`) }))

let text = ''
if (fs.existsSync(configPath)) {
  text = fs.readFileSync(configPath, 'utf8')
}
let lines = text ? text.split(/\r?\n/) : ['plugins:']
const matches = []
for (let i = 0; i < lines.length; i++) {
  for (const item of keyRegexes) {
    const m = lines[i].match(item.re)
    if (m) {
      matches.push({ index: i, key: item.key })
      break
    }
  }
}

function normalizeLineKey(index, oldKey) {
  if (oldKey === desiredKey) return false
  const re = new RegExp(`^(\\s*)${escapeRe(oldKey)}((?::[a-z0-9]+)?\\s*:.*)$`)
  lines[index] = lines[index].replace(re, `$1${desiredKey}$2`)
  return true
}

if (matches.length > 1) {
  normalizeLineKey(matches[0].index, matches[0].key)
  const remove = new Set(matches.slice(1).map(item => item.index))
  lines = lines.filter((_, index) => !remove.has(index))
  fs.writeFileSync(configPath, lines.join('\n'), 'utf8')
  console.log(`cleaned duplicate koishi entries for ${desiredKey}`)
  process.exit(0)
}

if (matches.length === 1) {
  if (normalizeLineKey(matches[0].index, matches[0].key)) {
    fs.writeFileSync(configPath, lines.join('\n'), 'utf8')
    console.log(`renamed koishi entry: ${matches[0].key} -> ${desiredKey}`)
    process.exit(0)
  }
  console.log(`already enabled: ${matches[0].key}`)
  process.exit(0)
}

fs.mkdirSync(require('path').dirname(configPath), { recursive: true })
if (text && fs.existsSync(configPath)) {
  fs.copyFileSync(configPath, `${configPath}.bak-${desiredKey}`)
}

let inserted = false
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^(\s*)group:basic:\s*$/)
  if (m) {
    lines.splice(i + 1, 0, `${m[1]}  ${desiredKey}: {}`)
    inserted = true
    break
  }
}
if (!inserted) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)plugins:\s*$/)
    if (m) {
      lines.splice(i + 1, 0, `${m[1]}  ${desiredKey}: {}`)
      inserted = true
      break
    }
  }
}
if (!inserted) {
  if (lines.length && lines[lines.length - 1] !== '') lines.push('')
  lines.push('plugins:')
  lines.push(`  ${desiredKey}: {}`)
}
fs.writeFileSync(configPath, lines.join('\n'), 'utf8')
console.log(`enabled: ${desiredKey}`)
NODE

printf "\nInstalled %s %s to %s\n" "$PACKAGE_NAME" "$PACKAGE_VERSION" "$DEST"
