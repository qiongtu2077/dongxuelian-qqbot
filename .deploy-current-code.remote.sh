#!/usr/bin/env bash
set -euo pipefail

APP=/root/koishi-app
DASHBOARD_PORT=${DASHBOARD_PORT:-5150}
cd "$APP"

echo "extract current code package"
test -f current-code.tgz
tar -xzf current-code.tgz

echo "sync restart script and normalize line endings"
cp scripts/restart-bot.sh restart.sh
sed -i 's/\r$//' restart.sh scripts/*.sh 2>/dev/null || true
chmod +x restart.sh scripts/*.sh 2>/dev/null || true

echo "syntax check"
node -c packages/koishi-plugin-dashboard/standalone.js
find packages -path '*/lib/*.js' -type f -print0 | xargs -0 -n1 node -c

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
curl -fsS "http://127.0.0.1:5140" >/dev/null && echo "koishi healthy"

rm -f current-code.tgz apply-current-code.sh
