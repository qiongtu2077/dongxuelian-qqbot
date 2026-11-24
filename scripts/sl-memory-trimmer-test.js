'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// 自动探测可用的 POSIX bash（兼容 Linux、任意盘符安装的 Git Bash 以及 WSL）。
function resolveBash() {
  if (process.platform !== 'win32') return { cmd: 'bash', prefixArgs: [], toPosix: p => path.resolve(p) }
  const probe = spawnSync('bash', ['-c', 'cygpath -u "$1"', '_', __dirname], { encoding: 'utf8', timeout: 5000 })
  if (probe.status === 0 && probe.stdout.trim()) {
    return {
      cmd: 'bash',
      prefixArgs: [],
      toPosix: file => {
        const conv = spawnSync('bash', ['-c', 'cygpath -u "$1"', '_', path.resolve(file)], { encoding: 'utf8', timeout: 5000 })
        assert.equal(conv.status, 0, 'cygpath conversion failed')
        return conv.stdout.trim()
      },
    }
  }
  return {
    cmd: 'wsl.exe',
    prefixArgs: ['--exec', 'bash'],
    toPosix: file => {
      const abs = path.resolve(file)
      const match = abs.match(/^([A-Za-z]):\\(.*)$/)
      assert(match, `cannot convert path for WSL: ${abs}`)
      return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`
    },
  }
}

const BASH_TEST_SCRIPT = [
  'set -Eeuo pipefail',
  'scripts="$1"',
  'fixture="$(mktemp -d /tmp/lian-sl-trimmer-test.XXXXXX)"',
  'trap \'rm -rf -- "$fixture"\' EXIT',
  '',
  'sh -n "$scripts/sl-memory-trimmer.sh"',
  'sh -n "$scripts/install-sl-memory-trimmer.sh"',
  'bash -n "$scripts/activate-dashboard-release.sh"',
  '',
  'mkdir -p "$fixture/bin" "$fixture/cgroup"',
  'export PATH="$fixture/bin:$PATH"',
  'export STATE_ACTIVE=1',
  'export ONEBOT_LISTEN=1',
  'export VNC_ESTAB=0',
  'export FAIL_SLEEP=0',
  'export CMD_LOG="$fixture/commands.log"',
  ': > "$CMD_LOG"',
  '',
  'cat > "$fixture/bin/systemctl" <<\'SH\'',
  '#!/bin/sh',
  'printf \'systemctl %s\\n\' "$*" >> "$CMD_LOG"',
  'case "${1:-}" in',
  '  is-active)',
  '    [ "${STATE_ACTIVE:-1}" = "1" ] && exit 0 || exit 3 ;;',
  '  set-property)',
  '    case "${3:-}" in',
  '      MemoryHigh=*M)',
  '        mb="${3#MemoryHigh=}"',
  '        mb="${mb%M}"',
  '        bytes=$((mb * 1048576))',
  '        printf \'%s\\n\' "$bytes" > "$SL_MEMORY_TRIM_CGROUP_DIR/memory.high"',
  '        cur="$(cat "$SL_MEMORY_TRIM_CGROUP_DIR/memory.current")"',
  '        if [ "$cur" -gt "$bytes" ]; then',
  '          printf \'%s\\n\' "$bytes" > "$SL_MEMORY_TRIM_CGROUP_DIR/memory.current"',
  '        fi',
  '        ;;',
  '    esac',
  '    exit 0 ;;',
  '  *)',
  '    exit 0 ;;',
  'esac',
  'SH',
  '',
  'cat > "$fixture/bin/ss" <<\'SH\'',
  '#!/bin/sh',
  'if [ "${1:-}" = "-tln" ]; then',
  '  [ "${ONEBOT_LISTEN:-1}" = "1" ] && printf \'LISTEN 0 511 127.0.0.1:8080 0.0.0.0:*\\n\'',
  '  exit 0',
  'fi',
  'if [ "${1:-}" = "-tn" ]; then',
  '  [ "${VNC_ESTAB:-0}" = "1" ] && printf \'ESTAB 0 0 127.0.0.1:5909 127.0.0.1:51234\\n\'',
  '  exit 0',
  'fi',
  'exit 0',
  'SH',
  '',
  'cat > "$fixture/bin/sleep" <<\'SH\'',
  '#!/bin/sh',
  'printf \'sleep %s\\n\' "${1:-}" >> "$CMD_LOG"',
  'if [ "${FAIL_SLEEP:-0}" = "1" ]; then exit 99; fi',
  'exit 0',
  'SH',
  '',
  'cat > "$fixture/bin/id" <<\'SH\'',
  '#!/bin/sh',
  'printf \'0\\n\'',
  'SH',
  '',
  'cat > "$fixture/bin/python3" <<\'SH\'',
  '#!/bin/sh',
  'printf \'iconify:%s\\n\' "${2:-}" >> "$CMD_LOG"',
  'cat >/dev/null',
  'exit 0',
  'SH',
  '',
  'cat > "$fixture/bin/xwininfo" <<\'SH\'',
  '#!/bin/sh',
  'exit 0',
  'SH',
  '',
  'chmod +x "$fixture/bin/"*',
  '',
  'export SL_MEMORY_TRIM_CGROUP_DIR="$fixture/cgroup"',
  'export SL_MEMORY_TRIM_HOLD_SEC=1',
  '',
  '# 1. 服务未激活时（如切回 NapCat）静默跳过。',
  'printf \'%s\\n\' $((260 * 1048576)) > "$fixture/cgroup/memory.current"',
  'printf \'active_anon %s\\ninactive_anon %s\\nactive_file %s\\n\' $((30 * 1048576)) $((180 * 1048576)) $((50 * 1048576)) > "$fixture/cgroup/memory.stat"',
  'printf \'max\\n\' > "$fixture/cgroup/memory.high"',
  'STATE_ACTIVE=0 sh "$scripts/sl-memory-trimmer.sh" --apply > "$fixture/inactive.log"',
  'grep -q \'is not active\' "$fixture/inactive.log"',
  'if grep -q \'set-property\' "$CMD_LOG"; then exit 1; fi',
  'echo \'PASS guard 1: inactive SnowLuma skips cleanly\'',
  '',
  '# 2. 未登录（OneBot 未监听）或正在查看 VNC 桌面时，绝不最小化窗口。',
  ': > "$CMD_LOG"',
  'STATE_ACTIVE=1 ONEBOT_LISTEN=0 sh "$scripts/sl-memory-trimmer.sh" --apply > "$fixture/unlogged.log"',
  'grep -q \'skip window iconify: onebot_ready=0\' "$fixture/unlogged.log"',
  'if grep -q \'^iconify:\' "$CMD_LOG"; then exit 1; fi',
  '',
  ': > "$CMD_LOG"',
  'printf \'%s\\n\' $((260 * 1048576)) > "$fixture/cgroup/memory.current"',
  'STATE_ACTIVE=1 ONEBOT_LISTEN=1 VNC_ESTAB=1 sh "$scripts/sl-memory-trimmer.sh" --apply > "$fixture/vncbusy.log"',
  'grep -q \'skip window iconify: onebot_ready=1 vnc_busy=1\' "$fixture/vncbusy.log"',
  'if grep -q \'^iconify:\' "$CMD_LOG"; then exit 1; fi',
  'echo \'PASS guard 2: QR scan / active VNC never iconifies windows\'',
  '',
  '# 3. 内存低于触发水位或冷页不足时跳过，且若遗留过低水位会自动恢复稳态。',
  ': > "$CMD_LOG"',
  'printf \'%s\\n\' $((185 * 1048576)) > "$fixture/cgroup/memory.current"',
  'printf \'%s\\n\' $((160 * 1048576)) > "$fixture/cgroup/memory.high"',
  'STATE_ACTIVE=1 ONEBOT_LISTEN=1 VNC_ESTAB=0 sh "$scripts/sl-memory-trimmer.sh" --apply > "$fixture/lowmem.log"',
  'grep -q \'skip reclaim: current=185MB\' "$fixture/lowmem.log"',
  'grep -q \'systemctl set-property lian-snowluma.service MemoryHigh=260M\' "$CMD_LOG"',
  'echo \'PASS guard 3: low memory skips thrashing and heals stuck low watermark\'',
  '',
  '# 4. 高驻留 + 高冷页时：dry-run 零改动；apply 动态按热集+48MB 下探后恢复 260M，且不调用 restart。',
  ': > "$CMD_LOG"',
  'printf \'%s\\n\' $((275 * 1048576)) > "$fixture/cgroup/memory.current"',
  'printf \'active_anon %s\\ninactive_anon %s\\nactive_file %s\\n\' $((40 * 1048576)) $((155 * 1048576)) $((80 * 1048576)) > "$fixture/cgroup/memory.stat"',
  'sh "$scripts/sl-memory-trimmer.sh" > "$fixture/dry.log"',
  'grep -q \'DRY-RUN would reclaim: current=275MB inactive_anon=155MB hot=120MB target=168MB steady=260MB\' "$fixture/dry.log"',
  'if grep -q \'set-property\' "$CMD_LOG"; then exit 1; fi',
  '',
  'sh "$scripts/sl-memory-trimmer.sh" --apply > "$fixture/apply.log"',
  'grep -q \'^iconify::199$\' "$CMD_LOG"',
  'grep -q \'systemctl set-property lian-snowluma.service MemoryHigh=168M\' "$CMD_LOG"',
  'grep -q \'systemctl set-property lian-snowluma.service MemoryHigh=260M\' "$CMD_LOG"',
  'if grep -Eq \'restart|stop\' "$CMD_LOG"; then exit 1; fi',
  'grep -q \'APPLY reclaimed: before=275MB after=168MB target=168MB steady=260MB\' "$fixture/apply.log"',
  'echo \'PASS dynamic cold-page reclaim and steady watermark restore\'',
  '',
  '# 5. 中途异常退出时 trap 仍强制恢复 MemoryHigh=260M。',
  ': > "$CMD_LOG"',
  'printf \'%s\\n\' $((275 * 1048576)) > "$fixture/cgroup/memory.current"',
  'if FAIL_SLEEP=1 sh "$scripts/sl-memory-trimmer.sh" --apply > /dev/null 2>&1; then exit 1; fi',
  'tail -n 1 "$CMD_LOG" | grep -q \'systemctl set-property lian-snowluma.service MemoryHigh=260M\'',
  'echo \'PASS guard 4: trap restores steady MemoryHigh on interruption\'',
  '',
  '# 6. 安装脚本只写隔离根目录并启用 timer，绝不重启任何业务服务。',
  ': > "$CMD_LOG"',
  'export LIAN_TRIMMER_INSTALL_ROOT="$fixture/install-root"',
  'sh "$scripts/install-sl-memory-trimmer.sh" > "$fixture/install.log"',
  'test -x "$LIAN_TRIMMER_INSTALL_ROOT/usr/local/sbin/sl-memory-trimmer.sh"',
  'grep -q \'^ExecStart=/usr/local/sbin/sl-memory-trimmer.sh --apply$\' "$LIAN_TRIMMER_INSTALL_ROOT/etc/systemd/system/lian-sl-memory-trimmer.service"',
  'grep -q \'^OnUnitActiveSec=20min$\' "$LIAN_TRIMMER_INSTALL_ROOT/etc/systemd/system/lian-sl-memory-trimmer.timer"',
  'grep -q \'systemctl enable --now lian-sl-memory-trimmer.timer\' "$CMD_LOG"',
  'if grep -Eq \'restart|lian-snowluma|lian-koishi\' "$CMD_LOG"; then exit 1; fi',
  'echo \'PASS installer writes service/timer and never restarts SnowLuma\'',
  '',
].join('\n')

// 在纯临时沙箱验证四道安全守卫与 systemd timer 安装契约，不触碰宿主真实服务。
function main() {
  const shell = resolveBash()
  const args = [...(shell.prefixArgs || []), '-s', '--', shell.toPosix(__dirname)]
  const result = spawnSync(shell.cmd, args, {
    encoding: 'utf8',
    timeout: 60000,
    input: BASH_TEST_SCRIPT,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert.ifError(result.error)
  assert.equal(result.status, 0, 'SnowLuma memory trimmer tests failed')
}

main()
