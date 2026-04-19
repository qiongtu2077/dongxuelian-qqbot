# NapCat + Koishi 当前状态
更新时间：2026-04-19

## 当前结论
- 主链路已打通：`NapCat + Koishi + OneBot11` 正常工作。
- QQ 机器人账号：`123456789`。
- `help` 已验证可回复，机器人当前可正常收发消息。
- **B 方案已打通**：走 `Koishi + yt-dlp + ffmpeg + QQ 回传`，现在机器人已能在收到 B 站内容后自动回传视频文件。

## 已完成

### 主链路
- `NapCat` 已接入 `systemd`，并设置开机自启。
- `Koishi` 已接入 `systemd`，并设置开机自启。
- `NapCat` 与 `Koishi` 通过 `OneBot11 正向 WebSocket` 连接成功。
- `NapCat OneBot11` 监听端口：`3001`。
- `Koishi console` 端口已改为 `5141`。
- `NapCat` 的 `systemd` 关键修复已完成：
  - `User=root`
  - `Environment=HOME=/root`
  - `WorkingDirectory=/root`
- 修复后，`NapCat` 能正确读取 `/root` 下配置并拉起 `3001`。

### B 站解析与搬运
- 已安装 `koishi-plugin-puppeteer`。
- 已安装 `Chromium`，实际可执行文件：`/usr/bin/chromium-browser`。
- `puppeteer` 已配置 `executablePath: /usr/bin/chromium-browser`。
- 已移除 `@summonhim/koishi-plugin-bili-parser`，避免与自定义搬运逻辑重复回复。
- 自定义插件 `local-video-sender:test` 已接管 B 站触发逻辑。
- 当前已支持以下触发方式：
  - 纯 `BV号`
  - 完整 B 站链接
  - 带标题的分享文本
  - `b23.tv` 短链
- 当前回复流程已完成整合：
  - 先发一条：标题 / UP / 时长 / 清晰度 / 预计大小 / 链接 + 封面
  - 再直接发视频
  - 不再发送“开始下载中”的单独提示
- 超过 `200MB` 的视频不搬运，直接提示去 B 站观看。

### 下载工具链
- `ffmpeg` 已可用：`/usr/bin/ffmpeg`。
- `yt-dlp` 已安装成功：`/usr/local/bin/yt-dlp`。
- 已确认使用的是 Linux 独立二进制，不再依赖系统 `Python 3.6.8`。
- `yt-dlp --version` 当前结果：`2026.03.17`。
- `file /usr/local/bin/yt-dlp` 已确认是 `ELF 64-bit executable`。

### Cookies 与下载验证
- B 站 cookies 文件已放到服务器：`/root/bilibili-cookies.txt`。
- 未带 cookies 时，`yt-dlp` 访问 B 站会报 `HTTP 412`。
- 带 cookies 后，`yt-dlp` 已能正常列出 `BV1o2d5BkEG3` 的可下载格式。
- 已实测下载并合并成功：
  - 测试命令使用 `30066+30280`
  - 输出文件：`/root/test_bili.mp4`
  - 输出大小：约 `23M`
- 这说明服务器端已经具备“下载 B 站视频并合并输出 mp4”的能力。

## 当前已验证
- 本地视频回传 QQ 已验证成功：`local-video-sender:test` 可通过 `sendtestvideo` 发送 `/root/test_bili.mp4`。
- 自动搬运已验证成功：发送 `BV号` / B 站链接 / 分享文本后，机器人会自动回传视频。
- `ffprobe` 已确认测试视频本体为 `1280x720`，未被裁切；QQ 中出现的方形预览属于客户端封面显示效果。
- 下载前探测已接入：会先探测可用 `720p` 格式和预计大小，再决定是否下载。
- 当前优先使用 `720p`：
  - `30064+30280`
  - `30066+30280`
  - `100024+30280`

## 当前阻塞
- `5141` 公网访问仍异常，但**不影响机器人本体功能**，当前不是主阻塞。

## 关键文件
- Koishi 主配置：`/root/koishi-app/koishi.yml`
- Koishi 服务：`/etc/systemd/system/koishi.service`
- NapCat 服务：`/etc/systemd/system/napcat.service`
- NapCat 日志：`/root/Napcat/log/napcat_123456789.log`
- NapCat OneBot 配置：`/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/config/onebot11_123456789.json`
- B 站 cookies：`/root/bilibili-cookies.txt`
- yt-dlp：`/usr/local/bin/yt-dlp`
- 下载测试文件：`/root/test_bili.mp4`
- 自定义搬运插件：`/root/koishi-app/node_modules/koishi-plugin-local-video-sender/lib/index.js`

## 下一步（B 方案）
1. 观察一段时间，确认关闭 `bili-parser` 后不再出现重复回复。
2. 视需要再扩展：
   - 支持更多 B 站分享样式
   - 优化异常提示文案
   - 增加清理策略与失败日志定位
3. 如有必要，再单独处理 `5141` 公网访问问题。

## 常用命令
```bash
systemctl status koishi --no-pager -l
systemctl status napcat --no-pager -l
journalctl -u koishi -n 50 --no-pager
tail -n 50 /root/Napcat/log/napcat_123456789.log
/usr/local/bin/yt-dlp --version
```

