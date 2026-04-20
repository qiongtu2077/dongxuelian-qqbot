# NapCat + Koishi 当前进度

更新时间：2026-04-20

## 总结

- QQ 机器人账号：`123456789`
- 主链路已稳定打通：`NapCat + Koishi + OneBot11`
- `NapCat` 和 `Koishi` 均已接入 `systemd`，并设置为服务化运行
- QQ 机器人当前可正常接收消息，`help` 命令已验证可正常回复
- 第一阶段 B 站视频解析/搬运功能已全部完成，当前运行正常
- 第二阶段开始规划群友昵称与集合管理，方便快速艾特

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

### systemd 修复记录

- `NapCat` 服务已固定运行环境：
  - `User=root`
  - `Environment=HOME=/root`
  - `WorkingDirectory=/root`
- 该修复解决了 `NapCat` 通过 `systemd` 启动时读不到 `/root/Napcat` 配置、导致 `3001` 不监听的问题

## 功能一：B 站视频解析/搬运

### 当前状态

- 状态：已完成，当前运行正常
- 插件实例：`local-video-sender:test`
- 插件文件：`/root/koishi-app/node_modules/koishi-plugin-local-video-sender/lib/index.js`
- 本地部署脚本记录：`1.md`
- 测试命令：`sendtestvideo`
- 手动命令：`bvidl <B站链接或BV号>`
- 自动监听：已开启，群内直接发送 B 站内容即可触发

### 支持输入

- 纯 `BV号`
- 完整 B 站视频链接
- 带标题的 B 站分享文本
- `b23.tv` 短链
- QQ 内 B 站小程序分享卡片

### 回复流程

- 第 1 条：视频标题、封面、规范短 BV 链接
- 第 2 条：视频文件
- 当前已将回复链接规范化为：`https://www.bilibili.com/video/BVxxxx/`
- 不再发送“开始下载中”的单独提示
- 超过 `200MB` 的视频不搬运，直接提示去 B 站观看

### 小程序分享解析

- 新增 `normalizeSharedText()`，用于处理 QQ 小程序卡片中的转义内容
- 支持反转义 `https:\/\/`、HTML 实体、Unicode 转义和百分号编码
- `extractBiliUrl()` 会先规范化文本，再提取 B 站 URL 或 `BV号`
- 已增加 `m.bilibili.com` 域名匹配
- 解析逻辑已写入 `1.md`，当前已验证可用

### 格式选择策略

- 优先选择 720P 分离流：
  - `30064+30280`：720P AVC
  - `30066+30280`：720P HEVC
  - `100024+30280`：720P AV1
- 其次兼容单文件流：
  - `64`：720P 单文件
  - `32`：480P 单文件
  - `16`：360P 单文件
- 兜底选择接近 720P 的分离流：
  - 高度范围：`700~720`
- 这样可以兼容 `1280x720`、`1280x714`、单文件 `720P` 等不同 B 站返回格式

### 已关闭插件

- 已从 `koishi.yml` 移除 `@summonhim/koishi-plugin-bili-parser`
- 原因：避免它与自定义搬运插件对同一条 B 站消息重复回复

## 工具链

- `yt-dlp`：`/usr/local/bin/yt-dlp`
- `yt-dlp` 版本：`2026.03.17`
- `yt-dlp` 类型：Linux 独立二进制，`ELF 64-bit executable`
- `ffmpeg`：`/usr/bin/ffmpeg`
- `Chromium`：`/usr/bin/chromium-browser`
- B 站 cookies：`/root/bilibili-cookies.txt`

## 已验证

- `help` 可正常回复
- `NapCat` 启动后 `3001` 正常监听
- `Koishi` 可连接 `NapCat`
- `sendtestvideo` 可发送 `/root/test_bili.mp4`
- `yt-dlp --cookies /root/bilibili-cookies.txt` 可绕过 B 站 `HTTP 412`
- `yt-dlp + ffmpeg` 已成功下载并合并 B 站视频
- `/root/test_bili.mp4` 已通过 `ffprobe` 确认为 `1280x720`，视频本体未被裁切
- QQ 内看到的方形视频预览属于客户端封面显示效果，不是视频被裁切
- 自动搬运已通过多种链接形态验证：
  - `BV1o2d5BkEG3`
  - `https://www.bilibili.com/video/BV1o2d5BkEG3`
  - `https://b23.tv/4BaVmcg`
  - `https://b23.tv/LGIhnLb`
- 回复中的 B 站链接已改为规范短链接样式

## 当前非主阻塞

- `Koishi console` 本机访问 `127.0.0.1:5141` 正常
- `5141` 公网访问仍异常
- 该问题不影响 QQ 机器人和 B 站视频解析/搬运功能，暂不作为主线处理
- 日志中的 `No open ports available` 仍可能出现，但目前不影响机器人功能

## 功能二：群友昵称与集合艾特

### 目标

- 为群友维护自定义昵称/别名，方便通过短名字快速艾特指定成员
- 支持把多个群友加入一个集合，方便一次性艾特一组人
- 后续作为第二阶段功能开发，不影响已完成的 B 站功能

### 初步设计

- 昵称能力：
  - 给 QQ 号绑定一个或多个昵称
  - 输入昵称时解析到对应 QQ 号并发送艾特
  - 支持查询、修改、删除昵称
- 集合能力：
  - 创建集合，例如 `打本队`、`管理组`、`常驻群友`
  - 向集合添加或移除成员
  - 输入集合名时展开为多个艾特
- 数据存储：
  - 优先考虑使用 Koishi 数据库或独立 JSON 文件持久化
  - 需要避免重启后昵称和集合丢失
- 权限控制：
  - 普通群友可查询
  - 添加、删除、修改建议限制为管理员或指定主人

### 待确认命令草案

```text
nick add <昵称> <QQ号>
nick del <昵称>
nick list
nick who <昵称>
at <昵称>

group add <集合名>
group del <集合名>
group member add <集合名> <QQ号或昵称>
group member del <集合名> <QQ号或昵称>
group list
group at <集合名>
```

### 开发状态

- 状态：准备开始
- 当前仅整理需求与进度文档，尚未写入功能代码
- 下一步：确定命令格式、存储方式和权限策略后开始实现插件

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
journalctl -u koishi -n 80 --no-pager | grep -i "local-video\|bili-parser\|error"
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

- 为 B 站搬运增加更详细的失败提示，例如 cookies 失效、视频无权限、无可用格式
- 增加临时目录定时清理，防止失败残留文件
- 根据群聊实际体验调整 `200MB` 限制
- 如有需要，再单独排查 `5141` 公网访问问题
