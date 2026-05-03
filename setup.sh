#!/bin/bash
# Dongxuelian Bot one-shot Linux setup script.
# Real mode installs dependencies, NapCat, Koishi config, data files, and starts Koishi.
# Test mode (`SETUP_MODE=simulate-files`) only writes config/data files into a safe temp root.

set -e

# ===== user config / env override =====
QQ_NUMBER="${QQ_NUMBER:-}"        # QQ account used by the bot.
ADMIN_QQ="${ADMIN_QQ:-}"          # Bot admin QQ.
# ======================================

GIT_REPO="${GIT_REPO:-https://github.com/qiongtu2077/dongxuelian-qqbot.git}"
SETUP_MODE="${SETUP_MODE:-install}"
SETUP_TEST_ROOT="${SETUP_TEST_ROOT:-}"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$SCRIPT_DIR}"
KOISHI_DIR="${KOISHI_DIR:-/root/koishi-app}"
DATA_DIR="${DATA_DIR:-$KOISHI_DIR/data}"
NAPCAT_DIR="${NAPCAT_DIR:-/root/Napcat}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log() { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[!] $1${NC}"; }
err() { echo -e "${RED}[x] $1${NC}"; exit 1; }

[ -z "$QQ_NUMBER" ] && err "Please set QQ_NUMBER before running setup.sh"
[ -z "$ADMIN_QQ" ] && err "Please set ADMIN_QQ before running setup.sh"

ensure_simulation_paths_safe() {
  [ "$SETUP_MODE" = "simulate-files" ] || return 0
  [ -n "$SETUP_TEST_ROOT" ] || err "SETUP_TEST_ROOT is required in simulate-files mode"

  mkdir -p "$SETUP_TEST_ROOT"
  root_abs="$(cd "$SETUP_TEST_ROOT" && pwd -P)"

  for output_dir in "$KOISHI_DIR" "$DATA_DIR" "$NAPCAT_DIR"; do
    case "$output_dir" in
      /*) output_abs="${output_dir%/}" ;;
      *) output_abs="$(pwd -P)/${output_dir%/}" ;;
    esac
    case "$output_abs/" in
      "$root_abs"/*) ;;
      *) err "simulate-files output path escapes SETUP_TEST_ROOT: $output_abs" ;;
    esac
  done
  mkdir -p "$KOISHI_DIR" "$DATA_DIR" "$NAPCAT_DIR"
}

write_napcat_config() {
  napcat_config="$NAPCAT_DIR/opt/QQ/resources/app/app_launcher/napcat/config"
  mkdir -p "$napcat_config"

  log "Writing NapCat config..."
  cat > "$napcat_config/napcat.json" <<'EOF'
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

  log "Writing NapCat OneBot WebSocket config..."
  cat > "$napcat_config/onebot11_$QQ_NUMBER.json" <<EOF
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
}

write_koishi_config() {
  mkdir -p "$KOISHI_DIR"
  log "Writing koishi.yml..."
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
}

copy_ai_skills() {
  skill_src="$REPO_ROOT/packages/koishi-plugin-dongxuelian-ai/data/ai-skills"
  for skill_part in core personas modes lore; do
    mkdir -p "$DATA_DIR/ai-skills/$skill_part"
    cp -rn "$skill_src/$skill_part/"* "$DATA_DIR/ai-skills/$skill_part/" 2>/dev/null || true
  done
}

create_data_files() {
  log "Creating data directory..."
  mkdir -p "$DATA_DIR/ai-skills/core" "$DATA_DIR/ai-skills/personas" "$DATA_DIR/ai-skills/modes" "$DATA_DIR/ai-skills/lore"
  mkdir -p "$DATA_DIR/user-profiles" "$DATA_DIR/conversations" "$DATA_DIR/ai-event-dumps"
  mkdir -p "$DATA_DIR/political-handlers"

  copy_ai_skills

  echo "opencode" > "$DATA_DIR/ai-provider.txt"
  echo "deepseek-v4-flash" > "$DATA_DIR/ai-model.txt"
  echo "https://opencode.ai/zen/go/v1" > "$DATA_DIR/ai-base-url.txt"
  echo "[]" > "$DATA_DIR/ai-random-whitelist.json"
  echo "[]" > "$DATA_DIR/ai-user-blacklist.json"
  echo "{}" > "$DATA_DIR/ai-repeat-enabled.json"
  echo "[]" > "$DATA_DIR/ai-random-rate.json"
  echo "off" > "$DATA_DIR/ai-enable-search.txt"
  echo "off" > "$DATA_DIR/ai-enable-thinking.txt"
}

run_simulation() {
  ensure_simulation_paths_safe
  log "simulate-files mode: writing config and data files only"
  write_napcat_config
  write_koishi_config
  create_data_files
  echo "sk-simulated-deepseek" > "$DATA_DIR/ai-deepseek-key.txt"
  echo "sk-simulated-opencode" > "$DATA_DIR/ai-openai-key.txt"
  echo "sk-simulated-dashscope" > "$DATA_DIR/ai-dashscope-key.txt"
  echo "sk-simulated-glm" > "$DATA_DIR/ai-glm-key.txt"
  log "simulate-files complete"
}

if [ "$SETUP_MODE" = "simulate-files" ]; then
  run_simulation
  exit 0
fi

# ==========================================
# 1. system dependencies
# ==========================================
log "Installing system dependencies..."
apt-get update -y -qq
apt-get install -y -qq curl wget git unzip jq xvfb screen procps \
  tesseract-ocr tesseract-ocr-chi-sim ffmpeg python3 python3-pip

pip3 install yt-dlp -q 2>/dev/null || warn "yt-dlp install failed, skipping"

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  log "Installing Node.js 18..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y -qq nodejs
fi
log "Node.js $(node -v) is ready"

# ==========================================
# 2. install NapCat + LinuxQQ
# ==========================================
log "Downloading NapCat installer..."
if [ -f napcat.sh ]; then
  log "napcat.sh already exists, skipping download"
else
  curl -k -L -# -o napcat.sh "https://nclatest.znin.net/NapNeko/NapCat-Installer/raw/main/install.sh"
  chmod +x napcat.sh
fi

log "Running NapCat installer..."
bash napcat.sh --docker n --cli y --proxy 0 --force 2>&1 | tail -5

# ==========================================
# 3. write NapCat config
# ==========================================
write_napcat_config

# ==========================================
# 4. clone repository + npm install
# ==========================================
if [ -d "$KOISHI_DIR/.git" ]; then
  warn "$KOISHI_DIR already exists, running git pull"
  cd "$KOISHI_DIR" && git pull
elif [ -d "$KOISHI_DIR" ]; then
  warn "$KOISHI_DIR exists but is not a git repository"
  cd "$KOISHI_DIR"
else
  log "Cloning repository..."
  git clone "$GIT_REPO" "$KOISHI_DIR"
  cd "$KOISHI_DIR"
fi

REPO_ROOT="$KOISHI_DIR"
log "Installing npm dependencies..."
npm install

# ==========================================
# 5. write koishi.yml
# ==========================================
write_koishi_config

# ==========================================
# 6. create data directory
# ==========================================
create_data_files

# ==========================================
# 7. start NapCat
# ==========================================
log "Starting NapCat..."
qq_exec="$NAPCAT_DIR/opt/QQ/qq"

if screen -ls | grep -q napcat; then
  warn "NapCat is already running, skipping start"
else
  screen -dmS napcat bash -c "xvfb-run -a '$qq_exec' --no-sandbox -q $QQ_NUMBER"
  log "NapCat started. Attach to the screen session to scan QR code."
  sleep 5
  screen -r napcat
fi

# ==========================================
# 8. wait for QQ login
# ==========================================
log "Waiting for QQ login..."
napcat_config="$NAPCAT_DIR/opt/QQ/resources/app/app_launcher/napcat/config"
wait_max=180
wait_now=0
while [ "$wait_now" -lt "$wait_max" ]; do
  if [ -f "$napcat_config/onebot11_$QQ_NUMBER.json" ]; then
    log "QQ login config detected"
    break
  fi
  sleep 3
  wait_now=$((wait_now + 3))
done

if [ "$wait_now" -ge "$wait_max" ]; then
  err "QQ login timed out after ${wait_max}s. Check whether NapCat is running."
fi

# ==========================================
# 9. input API keys
# ==========================================
echo ""
log "==================== API key config ===================="
log "At least one API key is required."
echo ""

read -p "DeepSeek API key (sk-xxx, required): " DEEPSEEK_KEY
[ -z "$DEEPSEEK_KEY" ] && err "DeepSeek API key cannot be empty"

read -p "mimorium API key (tp-xxx, optional): " MIMORIUM_KEY
read -p "opencode API key (sk-xxx, optional): " OPENCODE_KEY
read -p "dashscope API key (sk-xxx, optional): " DASHSCOPE_KEY
read -p "GLM API key (optional): " GLM_KEY

echo "$DEEPSEEK_KEY" > "$DATA_DIR/ai-deepseek-key.txt"
[ -n "$MIMORIUM_KEY" ] && echo "$MIMORIUM_KEY" > "$DATA_DIR/ai-mimorium-key.txt"
[ -n "$OPENCODE_KEY" ] && echo "$OPENCODE_KEY" > "$DATA_DIR/ai-openai-key.txt"
[ -n "$DASHSCOPE_KEY" ] && echo "$DASHSCOPE_KEY" > "$DATA_DIR/ai-dashscope-key.txt"
[ -n "$GLM_KEY" ] && echo "$GLM_KEY" > "$DATA_DIR/ai-glm-key.txt"

echo "deepseek" > "$DATA_DIR/ai-provider.txt"
echo "deepseek-chat" > "$DATA_DIR/ai-model.txt"
echo "https://api.deepseek.com" > "$DATA_DIR/ai-base-url.txt"

log "API keys written"

# ==========================================
# 10. start Koishi
# ==========================================
log "Starting Koishi..."
cd "$KOISHI_DIR"
nohup npx koishi start >> koishi.log 2>&1 &
sleep 10

if tail -3 koishi.log | grep -q 'dongxuelian-ai.*0.9'; then
  log "Deploy finished. Koishi has started."
  echo ""
  echo "  Logs: tail -f /root/koishi-app/koishi.log"
  echo "  Restart bot: bash /root/koishi-app/deploy.sh"
  echo "  Web console: http://SERVER_IP:5140"
else
  warn "Koishi is starting. Check logs manually: tail -f /root/koishi-app/koishi.log"
fi
