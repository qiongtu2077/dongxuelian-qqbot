'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// --- POSIX 行为夹具 ---

/** 将本机脚本目录映射为现有 WSL 测试环境可读取的路径。 */
function toBashPath(file) {
  const absolute = path.resolve(file)
  if (process.platform !== 'win32') return absolute
  const match = absolute.match(/^([A-Za-z]):\\(.*)$/)
  assert(match, `cannot map Windows path into WSL: ${absolute}`)
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`
}

/** 运行真实清理和轮转脚本；所有删除只作用于 POSIX 临时夹具。 */
function main() {
  const shell = process.platform === 'win32' ? 'wsl.exe' : 'bash'
  const args = [...(process.platform === 'win32' ? ['--exec', 'bash'] : []), '-s', '--', toBashPath(__dirname)]
  const result = spawnSync(shell, args, { encoding: 'utf8', timeout: 120000, input: String.raw`
set -Eeuo pipefail
scripts="$1"
fixture_root="$(mktemp -d /tmp/lian-qq-cache-test.XXXXXX)"
case "$fixture_root" in /tmp/lian-qq-cache-test.*) ;; *) exit 1 ;; esac
trap 'rm -rf -- "$fixture_root"' EXIT
trap 'echo "ops fixture failed at line $LINENO" >&2' ERR
for script in qq-cache-cleaner.sh install-qq-cache-cleaner.sh install-logrotate.sh; do
  sh -n "$scripts/$script"
done
bash -n "$scripts/activate-dashboard-release.sh"
napcat="$fixture_root/NapCat/QQ"
sl="$fixture_root/SnowLuma/home/.config/QQ"
nap_profile="$napcat/nt_qq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
sl_profile="$sl/nt_qq_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
export QQ_CACHE_CLEANER_CONFIG="$napcat" QQ_CACHE_CLEANER_SL_CONFIG="$sl"
for profile in "$nap_profile" "$sl_profile"; do
  for subdir in Pic Emoji Video log; do
    mkdir -p "$profile/nt_data/$subdir/month"
    printf 'expired cache' > "$profile/nt_data/$subdir/month/old"
    touch -d '5 days ago' "$profile/nt_data/$subdir/month/old"
    printf 'current cache' > "$profile/nt_data/$subdir/fresh"
  done
  mkdir -p "$profile/nt_db"
  touch -d '5 days ago' "$profile/nt_db/keep"
done
mkdir -p "$fixture_root/outside" "$napcat/global/nt_data/Emoji" "$fixture_root/koishi-app/data"
touch -d '5 days ago' "$fixture_root/outside/keep" "$napcat/global/nt_data/Emoji/keep" "$fixture_root/koishi-app/data/keep"
ln -s "$fixture_root/outside" "$nap_profile/nt_data/Pic/nested-link"
ln -s "$sl_profile" "$napcat/nt_qq_cccccccccccccccccccccccccccccccc"
mkdir -p "$napcat/nt_qq_dddddddddddddddddddddddddddddddd"
ln -s "$sl_profile/nt_data" "$napcat/nt_qq_dddddddddddddddddddddddddddddddd/nt_data"
mkdir -p "$napcat/nt_qq_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/nt_data"
ln -s "$fixture_root/outside" "$napcat/nt_qq_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/nt_data/Pic"
invalid="$napcat/nt_qq_aaaaaaaaaaaaaaaaz/nt_data/Pic"
mkdir -p "$invalid"
touch -d '5 days ago' "$invalid/keep"

# dry-run 必须同时命中两个协议，且不得删除过期文件。
sh "$scripts/qq-cache-cleaner.sh" > "$fixture_root/dry-run.log"
grep -Fq "profile: $nap_profile" "$fixture_root/dry-run.log"
grep -Fq "profile: $sl_profile" "$fixture_root/dry-run.log"
test -f "$nap_profile/nt_data/Pic/month/old"
test -f "$sl_profile/nt_data/Pic/month/old"
grep -q 'DRY-RUN total reclaimable:' "$fixture_root/dry-run.log"
echo 'PASS dual-protocol dry-run preserves files'

# apply 删除两套超期白名单文件，保留新文件、数据库和所有白名单外数据。
sh "$scripts/qq-cache-cleaner.sh" --apply > "$fixture_root/apply.log" 2>&1
for profile in "$nap_profile" "$sl_profile"; do
  for subdir in Pic Emoji Video log; do
    test ! -e "$profile/nt_data/$subdir/month/old"
    test -f "$profile/nt_data/$subdir/fresh"
    test -d "$profile/nt_data/$subdir"
  done
  test -f "$profile/nt_db/keep"
done
test -f "$fixture_root/outside/keep"
test -f "$napcat/global/nt_data/Emoji/keep"
test -f "$fixture_root/koishi-app/data/keep"
test -f "$invalid/keep"
grep -q 'skip symlink profile data:' "$fixture_root/apply.log"
grep -q 'skip symlink cache dir:' "$fixture_root/apply.log"
echo 'PASS expired caches removed; fresh files, databases and symlink targets preserved'

# 单目录覆盖不意外扫描 SL；未安装的 NapCat 也不阻断 SL。
QQ_CACHE_CLEANER_SL_CONFIG='' sh "$scripts/qq-cache-cleaner.sh" > "$fixture_root/single.log"
if grep -Fq "profile: $sl_profile" "$fixture_root/single.log"; then exit 1; fi
QQ_CACHE_CLEANER_CONFIG="$fixture_root/missing" sh "$scripts/qq-cache-cleaner.sh" > "$fixture_root/sl-only.log"
grep -Fq "profile: $sl_profile" "$fixture_root/sl-only.log"
echo 'PASS single-root override and SL-only installation'

# 空账号目录和未知参数必须向 systemd 返回失败。
if QQ_CACHE_CLEANER_CONFIG="$fixture_root/missing" QQ_CACHE_CLEANER_SL_CONFIG='' sh "$scripts/qq-cache-cleaner.sh" > /dev/null 2>&1; then exit 1; fi
if sh "$scripts/qq-cache-cleaner.sh" --unknown > /dev/null 2>&1; then exit 1; fi
echo 'PASS missing profiles and invalid arguments fail visibly'

# 仅替换 root/systemd/logrotate 边界，配置写入与路径校验运行生产实现。
mkdir -p "$fixture_root/bin"
printf '#!/bin/sh\nprintf "0\\n"\n' > "$fixture_root/bin/id"
printf '#!/bin/sh\nexit 0\n' > "$fixture_root/bin/systemctl"
printf '#!/bin/sh\ncat "$2" > "$LOGROTATE_CAPTURE"\n' > "$fixture_root/bin/logrotate"
chmod +x "$fixture_root/bin/"*
export PATH="$fixture_root/bin:$PATH"
export LIAN_LOGROTATE_CONFIG="$fixture_root/lian-bot.conf" LOGROTATE_CAPTURE="$fixture_root/validated.conf"
export KOISHI_APP_DIR="$fixture_root/koishi-app" NAPCAT_LOG_FILE="$fixture_root/napcat.log" SNOWLUMA_LOG_FILE="$fixture_root/SnowLuma/snowluma.log"
sh "$scripts/install-logrotate.sh"
cmp "$LIAN_LOGROTATE_CONFIG" "$LOGROTATE_CAPTURE"
grep -Fq "$SNOWLUMA_LOG_FILE" "$LIAN_LOGROTATE_CONFIG"
grep -q 'copytruncate' "$LIAN_LOGROTATE_CONFIG"
if SNOWLUMA_LOG_FILE='relative-path' sh "$scripts/install-logrotate.sh" > /dev/null 2>&1; then exit 1; fi
echo 'PASS SnowLuma log rotation and absolute-path guard'
` })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert.ifError(result.error)
  assert.equal(result.status, 0, 'QQ cache maintenance behavior tests failed')
}

main()
