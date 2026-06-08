#!/usr/bin/env bash
set -euo pipefail

APP="${KOISHI_APP_DIR:-${KOISHI_DIR:-$(pwd)}}"
DASHBOARD_PORT=${DASHBOARD_PORT:-5150}
cd "$APP"

echo "extract current code package"
test -f current-code.tgz
find packages -mindepth 2 -maxdepth 2 -type d -name lib -prune -exec rm -rf {} +
tar -xzf current-code.tgz

echo "sync restart script and normalize line endings"
cp scripts/restart-bot.sh restart.sh
sed -i 's/\r$//' restart.sh scripts/*.sh 2>/dev/null || true
chmod +x restart.sh scripts/*.sh 2>/dev/null || true

echo "syntax check"
node -c packages/koishi-plugin-dashboard/standalone.js
find packages -path '*/lib/*.js' -type f -print0 | xargs -0 -n1 node -c

echo "clean stale dashboard dist assets"
if [ -f packages/koishi-plugin-dashboard/frontend/dist/index.html ] && [ -d packages/koishi-plugin-dashboard/frontend/dist/assets ]; then
  keep_files="$(grep -oE 'assets/[^"'"'"' ]+' packages/koishi-plugin-dashboard/frontend/dist/index.html | sed 's#^assets/##' | sort -u || true)"
  find packages/koishi-plugin-dashboard/frontend/dist/assets -maxdepth 1 -type f \( -name 'index-*.js' -o -name 'index-*.css' \) | while IFS= read -r asset; do
    name="$(basename "$asset")"
    if ! printf '%s\n' "$keep_files" | grep -Fxq "$name"; then
      rm -f "$asset"
    fi
  done
fi

echo "sync plugin code to node_modules"
for pkgdir in packages/koishi-plugin-*; do
  [ -f "$pkgdir/package.json" ] || continue
  name=$(node -p "require('./' + process.argv[1] + '/package.json').name" "$pkgdir")
  dest="node_modules/$name"
  src_real=$(readlink -f "$pkgdir" 2>/dev/null || realpath "$pkgdir")
  dest_real=$(readlink -f "$dest" 2>/dev/null || true)
  if [ -n "$dest_real" ] && [ "$src_real" = "$dest_real" ]; then
    echo "workspace linked $name"
    continue
  fi
  mkdir -p "$dest"
  rm -rf "$dest/lib" "$dest/templates" "$dest/frontend/dist"
  [ -d "$pkgdir/lib" ] && cp -R "$pkgdir/lib" "$dest/lib"
  [ -d "$pkgdir/templates" ] && cp -R "$pkgdir/templates" "$dest/templates"
  if [ -d "$pkgdir/frontend/dist" ]; then
    mkdir -p "$dest/frontend"
    cp -R "$pkgdir/frontend/dist" "$dest/frontend/dist"
  fi
  [ -f "$pkgdir/index.js" ] && cp "$pkgdir/index.js" "$dest/index.js"
  [ -f "$pkgdir/standalone.js" ] && cp "$pkgdir/standalone.js" "$dest/standalone.js"
  cp "$pkgdir/package.json" "$dest/package.json"
  echo "synced $name"
done

echo "restart dashboard so the new frontend/backend is served"
pkill -f "$APP/packages/koishi-plugin-dashboard/standalone.js" 2>/dev/null || true
pkill -f 'node standalone.js' 2>/dev/null || true
sleep 2

echo "restart koishi"
bash restart.sh

echo "verify services"
curl -fsS "http://127.0.0.1:${DASHBOARD_PORT}/dashboard/" >/dev/null && echo "dashboard healthy"
ss -tlnp | grep -q ':5140' && echo "koishi healthy"

rm -f current-code.tgz apply-current-code.sh
