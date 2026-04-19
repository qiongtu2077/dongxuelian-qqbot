# NapCat + Koishi 当前状态

更新时间：2026-04-19

## 总结

- QQ 机器人账号：`123456789`
- 主链路已稳定打通：`NapCat + Koishi + OneBot11`
- `NapCat` 和 `Koishi` 均已接入 `systemd`，并设置开机自启
- `help` 已验证可正常回复，机器人当前可正常收发 QQ 消息
- B 站搬运功能已完成：发送 `BV号` / B 站链接 / 分享文本 / `b23.tv` 短链后，机器人会自动返回视频信息、封面和视频文件

## 主链路

### NapCat

- 启动脚本：`/usr/local/bin/_napcat_old`
- QQ 账号：`123456789`
- OneBot11 监听端口：`3001`
- OneBot11 配置：`/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/config/onebot11_123456789.json`
- 日志：`/root/Napcat/log/napcat_123456789.log`
- 服务：`/etc/systemd/system/napcat.service`

### Koishi

- 项目目录：`/root/koishi-app`
- 主配置：`/root/koishi-app/koishi.yml`
- 数据库：`/root/koishi-app/data/koishi.db`
- 服务：`/etc/systemd/system/koishi.service`
- 控制台端口：`5141`
- OneBot 连接目标：`ws://127.0.0.1:3001`

### systemd 修复

- `NapCat` 服务已固定运行环境：
  - `User=root`
  - `Environment=HOME=/root`
  - `WorkingDirectory=/root`
- 该修复解决了 `NapCat` 通过 `systemd` 启动时读不到 `/root/Napcat` 配置、导致 `3001` 不监听的问题。

## B 站搬运

### 当前效果

- 支持自动触发：
  - 纯 `BV号`
  - 完整 B 站链接
  - 带标题的分享文本
  - `b23.tv` 短链
- 回复流程：
  - 第 1 条：标题 / UP / 时长 / 清晰度 / 预计大小 / 链接 + 封面
  - 第 2 条：视频文件
- 不再发送“开始下载中”的单独提示。
- 超过 `200MB` 的视频不搬运，直接提示去 B 站观看。

### 自定义插件

- 插件实例：`local-video-sender:test`
- 插件文件：`/root/koishi-app/node_modules/koishi-plugin-local-video-sender/lib/index.js`
- 测试命令：`sendtestvideo`
- 手动命令：`bvidl <B站链接或BV号>`
- 自动监听：已开启，直接发 B 站内容即可触发。

### 格式选择策略

- 优先分离流 `720档`：
  - `30064+30280`：720档 AVC
  - `30066+30280`：720档 HEVC
  - `100024+30280`：720档 AV1
- 其次兼容单文件流：
  - `64`：720档单文件
  - `32`：480档单文件
  - `16`：360档单文件
- 兜底兼容接近 720 的分离流：
  - 高度范围：`700~720`
- 这样可以兼容 `1280x720`、`1280x714`、单文件 `720p` 等不同 B 站返回格式。

### 已关闭插件

- 已从 `koishi.yml` 移除 `@summonhim/koishi-plugin-bili-parser`
- 原因：避免它与自定义搬运插件对同一条 B 站消息重复回复。

## 工具链

- `yt-dlp`：`/usr/local/bin/yt-dlp`
- `yt-dlp` 版本：`2026.03.17`
- `yt-dlp` 类型：Linux 独立二进制 `ELF 64-bit executable`
- `ffmpeg`：`/usr/bin/ffmpeg`
- `Chromium`：`/usr/bin/chromium-browser`
- B 站 cookies：`/root/bilibili-cookies.txt`

## 已验证

- `help` 可正常回复。
- `NapCat` 启动后 `3001` 正常监听。
- `Koishi` 可连接 `NapCat`。
- `sendtestvideo` 可发送 `/root/test_bili.mp4`。
- `yt-dlp --cookies /root/bilibili-cookies.txt` 可绕过 B 站 `HTTP 412`。
- `yt-dlp + ffmpeg` 已成功下载并合并 B 站视频。
- `/root/test_bili.mp4` 已通过 `ffprobe` 确认为 `1280x720`，视频本体未被裁切。
- QQ 内看到的方形视频预览属于客户端封面显示效果，不是视频被裁切。
- 自动搬运已通过多种链接形态验证：
  - `BV1o2d5BkEG3`
  - `https://www.bilibili.com/video/BV1o2d5BkEG3`
  - `https://b23.tv/4BaVmcg`
  - `https://b23.tv/LGIhnLb`

## 当前非主阻塞

- `Koishi console` 本机访问 `127.0.0.1:5141` 正常。
- `5141` 公网访问仍异常。
- 该问题不影响 QQ 机器人和 B 站搬运功能，暂不作为主线处理。
- 日志中的 `No open ports available` 仍会出现，但目前不影响机器人功能。

## 常用命令

### 服务状态

```bash
systemctl status koishi --no-pager -l
systemctl status napcat --no-pager -l
```

### 重启服务

```bash
systemctl restart koishi
systemctl restart napcat
```

### 查看日志

```bash
journalctl -u koishi -n 80 --no-pager
tail -n 80 /root/Napcat/log/napcat_123456789.log
```

### 检查插件加载

```bash
journalctl -u koishi -n 80 --no-pager | grep -i "local-video\\|bili-parser\\|error"
```

### 检查 B 站格式

```bash
/usr/local/bin/yt-dlp --cookies /root/bilibili-cookies.txt -F "B站链接或b23短链"
```

### 检查 yt-dlp

```bash
/usr/local/bin/yt-dlp --version
file /usr/local/bin/yt-dlp
```

## 后续可选优化

- 增加更详细的失败提示，例如 cookies 失效、视频无权限、无可用格式。
- 增加临时目录定时清理，防止失败残留文件。
- 根据群聊实际体验调整 `200MB` 限制。
- 如有需要，再单独排查 `5141` 公网访问问题。
