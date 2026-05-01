#!/bin/bash
# 东雪莲 Bot 更新部署脚本
# 用法：复制到服务器后 bash deploy.sh
# 前置：服务器已有 /root/koishi-app 完整部署

KOISHI_DIR="/root/koishi-app"

cd "$KOISHI_DIR"

pkill -f 'koishi/lib/worker'
sleep 3
npx koishi start
