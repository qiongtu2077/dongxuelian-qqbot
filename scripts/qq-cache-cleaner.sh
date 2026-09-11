#!/bin/sh
# QQ NT 缓存清理：只删 QQ 客户端收到的图片/表情/视频/日志缓存。
#
# 背景见 issue #11 与运维记录：/root/.config/QQ 每月增长约 7G，大头是
# nt_data/Pic（群聊图片缓存）。Koishi 插件不负责这件事（跨平台、职责
# 边界），由服务器侧 systemd timer 每日调用本脚本。
#
# 安全约束（改这里之前先读 scripts/resource-cleanup.js 的同类约束）：
#   - 白名单制：只允许删 <QQ_CONFIG>/nt_qq_<hash>/nt_data/ 下固定的四个
#     子目录：Pic、Emoji、Video、log。其他一律不碰。
#   - 绝不触碰：nt_db（消息数据库）、nt_qq（程序数据）、NapCat/、
#     koishi-app/data（bot 内部数据：集合昵称/人格/记忆/today-cache）。
#   - 只删超过保留期的文件（find -mtime +N），目录本身保留，QQ 会继续用。
#   - 默认 dry-run：只统计。显式 --apply 才删除。
#   - 路径解析失败/越界直接退出，不做任何通配符递归 rm。
#
# 用法：
#   sh scripts/qq-cache-cleaner.sh                  # dry-run，仅统计
#   sh scripts/qq-cache-cleaner.sh --apply          # 实际执行删除
#   QQ_CACHE_CLEANER_CONFIG=/root/.config/QQ sh ... # 自定义 QQ 配置根目录
#   QQ_PIC_RETENTION_DAYS=7 sh ...                  # 自定义图片保留天数
set -eu

MODE="dry-run"
for arg in "$@"; do
  case "$arg" in
    --apply) MODE="apply" ;;
    *) echo "[qq-cache-cleaner] unknown argument: $arg" >&2; exit 1 ;;
  esac
done

QQ_CONFIG_ROOT="${QQ_CACHE_CLEANER_CONFIG:-/root/.config/QQ}"
# 保留期（天）。默认：图片/表情/视频 1 天（用户拍板"1天1删都行"），QQ 日志 3 天。
PIC_RETENTION_DAYS="${QQ_PIC_RETENTION_DAYS:-1}"
EMOJI_RETENTION_DAYS="${QQ_EMOJI_RETENTION_DAYS:-1}"
VIDEO_RETENTION_DAYS="${QQ_VIDEO_RETENTION_DAYS:-1}"
LOG_RETENTION_DAYS="${QQ_LOG_RETENTION_DAYS:-3}"

if [ ! -d "$QQ_CONFIG_ROOT" ]; then
  echo "[qq-cache-cleaner] QQ config root not found: $QQ_CONFIG_ROOT" >&2
  exit 1
fi

# 只接受 nt_qq_<至少16位hex> 形式的账号档案目录，避免误匹配程序目录 nt_qq。
total_removed_bytes=0
total_removed_files=0

human_size() {
  bytes="$1"
  if [ "$bytes" -ge 1073741824 ] 2>/dev/null; then
    echo "$((bytes / 1073741824))G"
  elif [ "$bytes" -ge 1048576 ] 2>/dev/null; then
    echo "$((bytes / 1048576))M"
  else
    echo "$((bytes / 1024))K"
  fi
}

# 清理一个子目录：统计（dry-run）或删除（apply）超过保留期的文件。
# 用法: clean_dir <profile_dir> <subdir> <retention_days>
clean_dir() {
  profile_dir="$1"; subdir="$2"; days="$3"
  target="$profile_dir/nt_data/$subdir"
  # 白名单校验：子目录名必须精确匹配，路径必须落在档案目录内。
  case "$subdir" in
    Pic|Emoji|Video|log) ;;
    *) echo "[qq-cache-cleaner] refused non-whitelisted subdir: $subdir" >&2; exit 1 ;;
  esac
  [ -d "$target" ] || return 0

  if [ "$MODE" = "dry-run" ]; then
    # du 汇总超期文件字节数（find -printf 在 busybox 下不可用，GNU find 足够）。
    bytes="$(find "$target" -type f -mtime +"$days" -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')"
    count="$(find "$target" -type f -mtime +"$days" 2>/dev/null | wc -l)"
    printf '  %-42s %8s  %6s files (>%sd)\n' "$subdir" "$(human_size "$bytes")" "$count" "$days"
    total_removed_bytes=$((total_removed_bytes + bytes))
    total_removed_files=$((total_removed_files + count))
  else
    before="$(du -sk "$target" 2>/dev/null | awk '{print $1}')"
    find "$target" -mindepth 1 -type f -mtime +"$days" -delete 2>/dev/null || true
    # 清掉删除后留下的空月度目录（Pic/2026-08 这类 YYYY-MM 层级），非空不动。
    find "$target" -mindepth 1 -type d -empty -delete 2>/dev/null || true
    after="$(du -sk "$target" 2>/dev/null | awk '{print $1}')"
    freed=$(( (before - after) * 1024 ))
    [ "$freed" -lt 0 ] && freed=0
    printf '  %-42s freed %8s\n' "$subdir" "$(human_size "$freed")"
    total_removed_bytes=$((total_removed_bytes + freed))
  fi
}

profile_count=0
for profile in "$QQ_CONFIG_ROOT"/nt_qq_*/; do
  [ -d "$profile" ] || continue
  case "${profile%/}" in
    */nt_qq_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) echo "[qq-cache-cleaner] skip non-profile dir: $profile"; continue ;;
  esac
  profile_count=$((profile_count + 1))
  echo "profile: $profile"
  clean_dir "$profile" Pic "$PIC_RETENTION_DAYS"
  clean_dir "$profile" Emoji "$EMOJI_RETENTION_DAYS"
  clean_dir "$profile" Video "$VIDEO_RETENTION_DAYS"
  clean_dir "$profile" log "$LOG_RETENTION_DAYS"
done

if [ "$profile_count" -eq 0 ]; then
  echo "[qq-cache-cleaner] no nt_qq_<hash> profile found under $QQ_CONFIG_ROOT" >&2
  exit 1
fi

if [ "$MODE" = "dry-run" ]; then
  echo "DRY-RUN total reclaimable: $(human_size "$total_removed_bytes") — rerun with --apply to delete"
else
  echo "APPLY total freed: $(human_size "$total_removed_bytes")"
fi
