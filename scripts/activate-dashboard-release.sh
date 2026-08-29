#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${1:-}"
RELEASE_ID="${2:-}"
RESULT_FILE="${3:-}"
DATA_DIR="${DONGXUELIAN_AI_DATA_DIR:-$APP_DIR/data}"
RELEASE_ROOT="$APP_DIR/.lian-releases"
NEXT_DIR="$RELEASE_ROOT/$RELEASE_ID.next"
FINAL_DIR="$RELEASE_ROOT/$RELEASE_ID"
CURRENT_LINK="$RELEASE_ROOT/current"
STAGE="preflight"
OLD_TARGET=""
SWITCHED=0
MIGRATED=0
MIGRATION_LEGACY=""
MANIFEST_HASH=""
CONTENT_HASH=""

case "$APP_DIR" in
  /*) ;;
  *) echo "app dir must be absolute" >&2; exit 2 ;;
esac
if [ "$APP_DIR" = "/" ] || ! printf '%s' "$RELEASE_ID" | grep -Eq '^[a-z0-9-]+$'; then
  echo "unsafe release target" >&2
  exit 2
fi
case "$RESULT_FILE" in
  "$DATA_DIR"/deploy-tasks/*.remote.json) ;;
  *) echo "result file must stay in data/deploy-tasks" >&2; exit 2 ;;
esac

PACKAGES="koishi-plugin-dashboard koishi-plugin-dongxuelian-ai koishi-plugin-dongxuelian-help koishi-plugin-group-name-at koishi-plugin-defense koishi-plugin-local-video-sender koishi-plugin-group-leave-notice koishi-plugin-dongxuelian-poke koishi-plugin-pet-bridge koishi-plugin-daily-report"

# Writes only release metadata and a bounded error string to the durable progress file.
write_result() {
  state="$1"
  stage="$2"
  error_text="${3:-}"
  rolled_back="${4:-false}"
  mkdir -p "$(dirname "$RESULT_FILE")"
  node - "$RESULT_FILE" "$state" "$stage" "$error_text" "$rolled_back" "$RELEASE_ID" "$MANIFEST_HASH" "$CONTENT_HASH" <<'NODE'
const fs = require('fs')
const [file, state, stage, error, rolledBack, releaseId, manifestHash, contentHash] = process.argv.slice(2)
const next = file + '.tmp'
fs.writeFileSync(next, JSON.stringify({ state, stage, error: String(error || '').slice(0, 2000), rolledBack: rolledBack === 'true', releaseId, manifestHash, contentHash, updatedAt: Date.now() }, null, 2))
fs.renameSync(next, file)
NODE
}

# Waits for Dashboard, bot, and the expected release identity to become healthy.
wait_for_runtime() {
  expected_manifest="${1:-}"
  for _ in $(seq 1 30); do
    sleep 1
    if ! systemctl is-active --quiet lian-dashboard; then continue; fi
    if [ -n "$expected_manifest" ]; then
      status_json="$(curl -fsS http://127.0.0.1:5150/dashboard/api/release-status 2>/dev/null || true)"
      if [ -z "$status_json" ]; then continue; fi
      if node - "$expected_manifest" "$status_json" <<'NODE'
try {
  const status = JSON.parse(process.argv[3])
  process.exit(status.ok && status.release && status.release.manifestHash === process.argv[2] && status.bot && status.bot.listening ? 0 : 1)
} catch { process.exit(1) }
NODE
      then return 0; fi
    elif curl -sS -o /dev/null http://127.0.0.1:5150/dashboard/ 2>/dev/null && (ss -tln 2>/dev/null | grep -q ':5140 ' || curl -sS -o /dev/null http://127.0.0.1:5140/ 2>/dev/null); then
      return 0
    fi
  done
  return 1
}

# Restores the old pointer and services after any post-switch activation failure.
rollback_release() {
  exit_code=$?
  trap - ERR INT TERM
  set +e
  rolled_back=false
  if [ "$SWITCHED" = "1" ] && [ -n "$OLD_TARGET" ] && [ -d "$OLD_TARGET" ]; then
    ln -s "$OLD_TARGET" "$CURRENT_LINK.rollback"
    mv -Tf "$CURRENT_LINK.rollback" "$CURRENT_LINK"
    if [ -x "$CURRENT_LINK/scripts/restart-bot.sh" ]; then
      bash "$CURRENT_LINK/scripts/restart-bot.sh" >/dev/null 2>&1 || true
    elif [ -x "$APP_DIR/restart.sh" ]; then
      bash "$APP_DIR/restart.sh" >/dev/null 2>&1 || true
    fi
    systemctl restart lian-dashboard >/dev/null 2>&1 || true
    old_manifest_hash=""
    if [ -f "$OLD_TARGET/release-manifest.json" ]; then
      old_manifest_hash="$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).manifestHash||'')}catch{}" "$OLD_TARGET/release-manifest.json")"
    fi
    if wait_for_runtime "$old_manifest_hash"; then rolled_back=true; fi
  elif [ "$MIGRATED" = "1" ] && [ -n "$MIGRATION_LEGACY" ] && [ -d "$MIGRATION_LEGACY" ]; then
    for base in packages node_modules; do
      for package_name in $PACKAGES; do
        rel="$base/$package_name"
        target="$APP_DIR/$rel"
        rm -rf "$target"
        if [ -e "$MIGRATION_LEGACY/$rel" ] || [ -L "$MIGRATION_LEGACY/$rel" ]; then
          mkdir -p "$(dirname "$target")"
          cp -a "$MIGRATION_LEGACY/$rel" "$target"
        fi
      done
    done
    rm -f "$CURRENT_LINK"
    if [ -x "$APP_DIR/restart.sh" ]; then bash "$APP_DIR/restart.sh" >/dev/null 2>&1 || true; fi
    systemctl restart lian-dashboard >/dev/null 2>&1 || true
    if wait_for_runtime ""; then rolled_back=true; fi
  fi
  write_result failed "$STAGE" "release activation failed at $STAGE (exit $exit_code)" "$rolled_back"
  exit 1
}
trap rollback_release ERR INT TERM

# Migrates managed paths once so one current-link switch changes every package together.
migrate_managed_paths() {
  legacy_id="legacy-$(date +%Y%m%d%H%M%S)"
  legacy_dir="$RELEASE_ROOT/$legacy_id"
  MIGRATION_LEGACY="$legacy_dir"
  existed_file="$legacy_dir/.existed-paths"
  mkdir -p "$legacy_dir"
  : > "$existed_file"
  for base in packages node_modules; do
    for package_name in $PACKAGES; do
      rel="$base/$package_name"
      source="$APP_DIR/$rel"
      if [ -e "$source" ] || [ -L "$source" ]; then
        mkdir -p "$legacy_dir/$base"
        cp -a "$source" "$legacy_dir/$rel"
        printf '%s\n' "$rel" >> "$existed_file"
      fi
    done
  done
  ln -s "$legacy_dir" "$CURRENT_LINK.next"
  mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
  MIGRATED=1
  for base in packages node_modules; do
    for package_name in $PACKAGES; do
      rel="$base/$package_name"
      target="$APP_DIR/$rel"
      rm -rf "$target"
      mkdir -p "$(dirname "$target")"
      ln -s "$CURRENT_LINK/$rel" "$target"
    done
  done
}

write_result running "$STAGE"
test -d "$NEXT_DIR"
test ! -e "$FINAL_DIR"
STAGE="verify_manifest"
write_result running "$STAGE"
VERIFY_JSON="$(node "$NEXT_DIR/scripts/verify-release-manifest.js" "$NEXT_DIR")"
MANIFEST_HASH="$(printf '%s' "$VERIFY_JSON" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(JSON.parse(s).manifestHash||''))")"
CONTENT_HASH="$(printf '%s' "$VERIFY_JSON" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(JSON.parse(s).contentHash||''))")"
test -n "$MANIFEST_HASH"

STAGE="prepare_logrotate"
write_result running "$STAGE"
KOISHI_APP_DIR="$APP_DIR" bash "$NEXT_DIR/scripts/install-logrotate.sh"

STAGE="prepare_service"
write_result running "$STAGE"
KOISHI_APP_DIR="$APP_DIR" DONGXUELIAN_AI_DATA_DIR="$DATA_DIR" bash "$NEXT_DIR/scripts/install-dashboard-service.sh"

STAGE="prepare_version"
write_result running "$STAGE"
mv "$NEXT_DIR" "$FINAL_DIR"
if [ ! -L "$CURRENT_LINK" ]; then migrate_managed_paths; fi
OLD_TARGET="$(readlink -f "$CURRENT_LINK")"
test -d "$OLD_TARGET"

STAGE="switch_version"
write_result running "$STAGE"
ln -s "$FINAL_DIR" "$CURRENT_LINK.next"
mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
SWITCHED=1

STAGE="restart_bot"
write_result running "$STAGE"
bash "$CURRENT_LINK/scripts/restart-bot.sh"

STAGE="restart_dashboard"
write_result running "$STAGE"
systemctl restart lian-dashboard

STAGE="health_check"
write_result running "$STAGE"
healthy=0
if wait_for_runtime "$MANIFEST_HASH"; then healthy=1; fi
test "$healthy" = "1"

trap - ERR INT TERM
STAGE="complete"
write_result success "$STAGE"
exit 0
