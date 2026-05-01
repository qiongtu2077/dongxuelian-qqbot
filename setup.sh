#!/bin/bash
# 东雪莲 Bot 一键部署脚本
# 用法：复制到服务器 bash setup.sh
# 前置：需要 2 个参数填在下面，其余在运行中交互输入

set -e

# ===== 用户配置（执行前修改） =====
QQ_NUMBER=""        # Bot 登录用的 QQ 号
ADMIN_QQ=""         # 你的 QQ 号（作为 bot 管理员）
# ===================================

GIT_REPO="https://github.com/qiongtu2077/dongxuelian-qqbot.git"
KOISHI_DIR="/root/koishi-app"
DATA_DIR="/root/koishi-app/data"
NAPcat_DIR="/root/Napcat"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log() { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[!] $1${NC}"; }
err() { echo -e "${RED}[✗] $1${NC}"; exit 1; }

# 检查必填参数
[ -z "$QQ_NUMBER" ] && err "请先编辑脚本顶部的 QQ_NUMBER"
[ -z "$ADMIN_QQ" ] && err "请先编辑脚本顶部的 ADMIN_QQ"

# ==========================================
# 1. 系统依赖
# ==========================================
log "安装系统依赖..."
apt-get update -y -qq
apt-get install -y -qq curl wget git unzip jq xvfb screen procps \
  tesseract-ocr tesseract-ocr-chi-sim ffmpeg python3 python3-pip

# yt-dlp（B站视频下载用）
pip3 install yt-dlp -q 2>/dev/null || warn "yt-dlp 安装失败，可跳过"

# Node.js 18+
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  log "安装 Node.js 18..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y -qq nodejs
fi
log "Node.js $(node -v) 已就绪"

# ==========================================
# 2. 安装 NapCat + LinuxQQ
# ==========================================
log "下载 NapCat 安装器..."
if [ -f napcat.sh ]; then
  log "napcat.sh 已存在，跳过下载"
else
  curl -k -L -# -o napcat.sh "https://nclatest.znin.net/NapNeko/NapCat-Installer/raw/main/install.sh"
  chmod +x napcat.sh
fi

log "运行 NapCat 安装器（静默模式，耗时较长）..."
# 参数：--docker n（Shell安装） --cli y（装TUI） --proxy 0（不用代理） --force（强制）
bash napcat.sh --docker n --cli y --proxy 0 --force 2>&1 | tail -5

# ==========================================
# 3. 写入 NapCat 配置
# ==========================================
NAPcat_CONFIG="$NAPcat_DIR/opt/QQ/resources/app/app_launcher/napcat/config"
mkdir -p "$NAPcat_CONFIG"

log "写入 NapCat 主配置..."
cat > "$NAPcat_CONFIG/napcat.json" <<'EOF'
{
  "fileLog": false,
  "consoleLog": true,
  "fileLogLevel": "debug",
  "consoleLogLevel": "info",
  "packetBackend": "auto",
  "packetServer": "",
  "o3HookMode": 1,
  "bypass": { "hook": false, "window": false, "module": false, "process": false, "container": false, "js": false },
  "webui": { "port": 6099, "token": "123" }
}
EOF

log "写入 NapCat OneBot 配置（WS 服务端 :8080）..."
cat > "$NAPcat_CONFIG/onebot11_$QQ_NUMBER.json" <<EOF
{
  "network": {
    "httpServers": [],
    "httpSseServers": [],
    "httpClients": [],
    "websocketServers": [
      { "name": "WebSocket Server", "enable": true, "host": "127.0.0.1", "port": 8080 }
    ],
    "websocketClients": [],
    "plugins": []
  },
  "musicSignUrl": "",
  "enableLocalFile2Url": false,
  "parseMultMsg": false,
  "imageDownloadProxy": "",
  "timeout": { "baseTimeout": 10000, "uploadSpeedKBps": 256, "downloadSpeedKBps": 256, "maxTimeout": 1800000 }
}
EOF

# ==========================================
# 4. 克隆仓库 + npm install
# ==========================================
if [ -d "$KOISHI_DIR" ]; then
  warn "$KOISHI_DIR 已存在，将执行 git pull"
  cd "$KOISHI_DIR" && git pull
else
  log "克隆仓库..."
  git clone "$GIT_REPO" "$KOISHI_DIR"
  cd "$KOISHI_DIR"
fi

log "安装 npm 依赖..."
npm install

# ==========================================
# 5. 写入 koishi.yml
# ==========================================
log "写入 koishi.yml..."
cat > "$KOISHI_DIR/koishi.yml" <<EOF
plugins:
  server:emicam:
    port: 5140
    selfUrl: http://localhost:5140
  adapter-onebot:xtqqgv:
    protocol: ws
    selfId: '$QQ_NUMBER'
    endpoint: ws://127.0.0.1:8080/onebot/v11/ws
  group-name-at:nyxxfd: {}
  dongxuelian-help:rlmpxx: {}
  dongxuelian-ai:hdi04m: {}
  dongxuelian-poke:nxf8l0: {}
  koishi-plugin-defense:xlyp9f: {}
  local-video-sender:k2w0u7: {}
  group-leave-notice:h6lfrz: {}
EOF

# ==========================================
# 6. 创建数据目录
# ==========================================
log "创建数据目录..."
mkdir -p "$DATA_DIR/ai-skills/core" "$DATA_DIR/ai-skills/personas" "$DATA_DIR/ai-skills/modes" "$DATA_DIR/ai-skills/lore"
mkdir -p "$DATA_DIR/user-profiles" "$DATA_DIR/conversations" "$DATA_DIR/ai-event-dumps"
mkdir -p "$DATA_DIR/political-handlers"

# 复制 SKILL 文件（如果仓库里有）
cp -rn "$KOISHI_DIR/packages/koishi-plugin-dongxuelian-ai/data/ai-skills/core/"* "$DATA_DIR/ai-skills/core/" 2>/dev/null || true
cp -rn "$KOISHI_DIR/packages/koishi-plugin-dongxuelian-ai/data/ai-skills/personas/"* "$DATA_DIR/ai-skills/personas/" 2>/dev/null || true

# 初始提供商配置
echo "opencode" > "$DATA_DIR/ai-provider.txt"
echo "deepseek-v4-flash" > "$DATA_DIR/ai-model.txt"
echo "https://opencode.ai/zen/go/v1" > "$DATA_DIR/ai-base-url.txt"
echo "[]" > "$DATA_DIR/ai-random-whitelist.json"
echo "[]" > "$DATA_DIR/ai-user-blacklist.json"
echo "{}" > "$DATA_DIR/ai-repeat-enabled.json"
echo "[]" > "$DATA_DIR/ai-random-rate.json"
echo "off" > "$DATA_DIR/ai-enable-search.txt"
echo "off" > "$DATA_DIR/ai-enable-thinking.txt"

# ==========================================
# 7. 启动 NapCat + 等待扫码
# ==========================================
log "启动 NapCat..."
QQ_EXEC="$NAPcat_DIR/opt/QQ/qq"

if screen -ls | grep -q napcat; then
  warn "NapCat 已在运行，跳过启动"
else
  screen -dmS napcat bash -c "xvfb-run -a '$QQ_EXEC' --no-sandbox -q $QQ_NUMBER"
  log "NapCat 已启动！请查看二维码："
  sleep 5
  screen -r napcat
fi

# ==========================================
# 8. 等待登录成功
# ==========================================
log "等待 QQ 扫码登录..."
WAIT_MAX=180
WAIT_NOW=0
while [ $WAIT_NOW -lt $WAIT_MAX ]; do
  if ls "$NAPcat_CONFIG/onebot11_$QQ_NUMBER.json" 2>/dev/null; then
    log "登录成功！"
    break
  fi
  sleep 3
  WAIT_NOW=$((WAIT_NOW + 3))
done

if [ $WAIT_NOW -ge $WAIT_MAX ]; then
  err "扫码超时（${WAIT_MAX}秒），请检查 NapCat 是否正常运行"
fi

# ==========================================
# 9. 输入 API Key
# ==========================================
echo ""
log "==================== API Key 配置 ===================="
log "至少需要填写一项 API key 才能正常使用。"
echo ""

read -p "请输入 DeepSeek API key（sk-xxx，必填）： " DEEPSEEK_KEY
[ -z "$DEEPSEEK_KEY" ] && err "DeepSeek API key 不能为空"

read -p "请输入 mimorium API key（tp-xxx，可选，回车跳过）： " MIMORIUM_KEY
read -p "请输入 opencode API key（sk-xxx，可选，回车跳过）： " OPENCODE_KEY
read -p "请输入 dashscope(阿里云) API key（sk-xxx，可选，回车跳过）： " DASHSCOPE_KEY
read -p "请输入 GLM API key（可选，回车跳过）： " GLM_KEY

# 写入 key 文件
echo "$DEEPSEEK_KEY" > "$DATA_DIR/ai-deepseek-key.txt"
[ -n "$MIMORIUM_KEY" ] && echo "$MIMORIUM_KEY" > "$DATA_DIR/ai-mimorium-key.txt"
[ -n "$OPENCODE_KEY" ] && echo "$OPENCODE_KEY" > "$DATA_DIR/ai-openai-key.txt"
[ -n "$DASHSCOPE_KEY" ] && echo "$DASHSCOPE_KEY" > "$DATA_DIR/ai-dashscope-key.txt"
[ -n "$GLM_KEY" ] && echo "$GLM_KEY" > "$DATA_DIR/ai-glm-key.txt"

# 默认使用 deepseek
echo "deepseek" > "$DATA_DIR/ai-provider.txt"
echo "deepseek-chat" > "$DATA_DIR/ai-model.txt"
echo "https://api.deepseek.com" > "$DATA_DIR/ai-base-url.txt"

log "API key 写入完成"

# ==========================================
# 10. 启动 Koishi
# ==========================================
log "启动 Koishi..."
cd "$KOISHI_DIR"
nohup npx koishi start >> koishi.log 2>&1 &
sleep 10

# 验证
if tail -3 koishi.log | grep -q 'dongxuelian-ai.*0.9'; then
  log "部署成功！Koishi 已启动。"
  echo ""
  echo "  查看日志： tail -f /root/koishi-app/koishi.log"
  echo "  重启 bot： bash /root/koishi-app/deploy.sh"
  echo "  管理后台： http://服务器IP:5140"
else
  warn "Koishi 启动中，请手动检查日志： tail -f /root/koishi-app/koishi.log"
fi
