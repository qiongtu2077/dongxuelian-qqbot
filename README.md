# 东雪莲 Bot 部署完整教程

本项目是一套运行在阿里云 ECS（Linux）上的 Koishi QQ 机器人，包含以下功能插件：

| 插件 | 部署文件 | 功能 |
|------|---------|------|
| `koishi-plugin-group-name-at` | `name.md` | 昵称绑定、集合管理、@成员 |
| `koishi-plugin-dongxuelian-help` | `help.md` | 分级帮助菜单 |
| `koishi-plugin-dongxuelian-ai` | `ai.md` | AI 自由聊天（东雪莲人设） |
| `koishi-plugin-local-video-sender` | `vedio.md` | B站视频解析转发 |
| `koishi-plugin-group-leave-notice` | `leave.md` | 退群通知 |

---

## 一、服务器环境准备

> 操作系统：CentOS / Ubuntu（以下示例用 root 登录）

### 1. 安装 Node.js（v18+）

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
# 或 CentOS：
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs
```

### 2. 初始化 Koishi

```bash
mkdir -p /root/koishi-app
cd /root/koishi-app
npm init -y
npm install koishi
```

### 3. 创建 koishi.yml（最小配置示例）

```bash
cat > /root/koishi-app/koishi.yml <<'EOF'
port: 5140
plugins:
  adapter-onebot:
    protocol: ws-reverse
    selfId: "你的QQ号"
    endpoint: ws://127.0.0.1:8080/onebot/v11/ws
EOF
```

> `adapter-onebot` 对应 go-cqhttp 或 LLOneBot。确保 QQ 客户端已在服务器上登录并开启 ws-reverse 监听。

---

## 二、部署各插件（按顺序）

每个插件的部署方式相同：

1. 用 SSH 连接服务器
2. 打开对应的 `.md` 文件（本地用记事本 / VS Code）
3. 全选（`Ctrl+A`）→ 复制
4. 粘贴到 SSH 终端，回车执行
5. 等待命令全部执行完毕（最后一行通常是注册插件到 koishi.yml）

### 第 1 步：部署 昵称/集合 插件（name.md）

复制 `name.md` 全文，粘贴到服务器执行。

**作用**：创建插件文件 + 自动把 `group-name-at: {}` 写入 `koishi.yml`。

**执行后验证**：

```bash
grep 'group-name-at' /root/koishi-app/koishi.yml
```

### 第 2 步：部署 帮助菜单 插件（help.md）

复制 `help.md` 全文，粘贴到服务器执行。

**作用**：创建帮助插件文件 + 写入 `koishi.yml`。

### 第 3 步：部署 退群通知 插件（leave.md）

复制 `leave.md` 全文，粘贴到服务器执行。

### 第 4 步：部署 视频解析 插件（vedio.md）

在执行前，必须先完成以下前置步骤：

#### 4a. 安装 yt-dlp

```bash
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
```

#### 4b. 安装 ffmpeg

```bash
# Ubuntu
apt-get install -y ffmpeg
# CentOS
yum install -y ffmpeg
```

#### 4c. 准备 B站 Cookie 文件

1. 在 Chrome 安装 `Get cookies.txt LOCALLY` 扩展
2. 登录 bilibili.com
3. 点击扩展 → 导出为 Netscape 格式
4. 上传到服务器：

```bash
# 在本地 PowerShell 执行（替换 YOUR_SERVER_IP）：
scp cookies.txt root@YOUR_SERVER_IP:/root/bilibili-cookies.txt
```

#### 4d. 执行部署脚本

复制 `vedio.md` 全文，粘贴到服务器执行。

**插件配置项**（在 `vedio.md` 顶部常量）：

| 常量 | 默认值 | 说明 |
|------|-------|------|
| `YTDLP` | `/usr/local/bin/yt-dlp` | yt-dlp 路径 |
| `COOKIES` | `/root/bilibili-cookies.txt` | B站 cookie 路径 |
| `WORKDIR` | `/root/koishi-bili-downloads` | 临时下载目录 |
| `MAX_SIZE` | `200MB` | 最大允许文件大小 |

### 第 5 步：部署 AI 聊天 插件（ai.md）

在执行前，需要先创建以下数据文件：

#### 5a. 写入 API Key

```bash
mkdir -p /root/koishi-app/data
echo "sk-你的APIkey" > /root/koishi-app/data/ai-openai-key.txt
```

#### 5b. 写入模型名

```bash
echo "qwen-plus" > /root/koishi-app/data/ai-model.txt
# 或 gpt-4o-mini、qwen-turbo 等，取决于你使用的接口
```

#### 5c. 写入 Base URL

```bash
echo "https://dashscope.aliyuncs.com/compatible-mode/v1" > /root/koishi-app/data/ai-base-url.txt
# 或 OpenAI 官方：https://api.openai.com/v1
```

#### 5d. （可选）添加 Skill 文件

Skill 是影响 AI 风格的补充提示词，放在以下目录：

```bash
mkdir -p /root/koishi-app/data/ai-skills
# 把 SKILL.md 上传到这个目录，文件名必须匹配 SKILL*.md
```

#### 5e. 执行部署脚本

复制 `ai.md` 全文，粘贴到服务器执行。

**脚本内部会自动**：
- 删除旧版本插件目录
- 写入新版插件文件
- 清理 koishi.yml 里旧的 `dongxuelian-ai` 配置
- 写入新的 `dongxuelian-ai: {}`

---

## 三、启动 / 重启 Koishi

### 手动启动（临时测试）

```bash
cd /root/koishi-app
node .
```

### 用 pm2 后台运行（推荐）

```bash
npm install -g pm2
cd /root/koishi-app
pm2 start "node ." --name koishi
pm2 save
pm2 startup  # 设置开机自启
```

### 重启

```bash
pm2 restart koishi
```

---

## 四、验证插件是否加载

Koishi 启动后，在日志里找以下字样：

```
group-name-at 0.4.7 loaded
dongxuelian-help 0.4.3 loaded
dongxuelian-ai 0.2.46 loaded
local-video-sender loaded
group-leave-notice 0.1.0 loaded
```

如果某个插件没有出现，说明 `koishi.yml` 里没有注册，手动补一行：

```bash
node -e "
const fs = require('fs');
let yml = fs.readFileSync('/root/koishi-app/koishi.yml','utf8');
if (!yml.includes('group-name-at')) yml += '\n  group-name-at: {}';
fs.writeFileSync('/root/koishi-app/koishi.yml', yml);
"
```

---

## 五、升级插件

每次本地 `*.md` 文件更新后，在服务器重新执行对应脚本，然后重启：

```bash
pm2 restart koishi
```

---

## 六、群内常用指令速查

### 昵称 / 集合

| 指令 | 说明 |
|------|------|
| `@A用户 昵称 名字` | 绑定昵称 |
| `查看昵称 名字` | 查看昵称绑定的成员 |
| `查看成员 @A用户` | 查看某人的所有昵称/集合 |
| `查看全部昵称` | 列出本群所有单人昵称 |
| `创建集合 集合名 @A @B` | 创建多人集合 |
| `集合添加 集合名 @A` | 向集合添加成员 |
| `集合删除 集合名 @A` | 从集合移除成员 |
| `查看集合 集合名` | 查看集合成员 |
| `查看全部集合` | 列出本群所有集合 |
| `复制集合 A B` | 把集合 A 复制为 B |
| `合并集合 A B` | 把 B 合并进 A |
| `集合交集 A B` | 输出 A∩B |
| `集合并集 A B` | 输出 A∪B |
| `集合差集 A B` | 输出 A-B |
| `at昵称` | @ 该昵称绑定的成员 |

### 帮助

| 指令 | 说明 |
|------|------|
| `help东雪莲` | 查看主菜单 |
| `help集合` | 查看集合详细帮助 |

### AI

| 指令 | 说明 |
|------|------|
| `@东雪莲opus` | 必定触发 AI 回复 |
| `AI状态` | 查看当前 AI 版本/配置 |
| `AI重载` | 重新读取配置文件和 skill，并清空上下文 |

### 视频

在群里发送 B站链接（`bilibili.com`、`b23.tv`、`BV` 号）即可触发自动解析和转发。

---

## 七、数据文件位置汇总

| 文件 | 说明 |
|------|------|
| `/root/koishi-app/data/ai-openai-key.txt` | AI API Key |
| `/root/koishi-app/data/ai-model.txt` | AI 模型名 |
| `/root/koishi-app/data/ai-base-url.txt` | AI Base URL |
| `/root/koishi-app/data/ai-skills/SKILL.md` | AI Skill 文件（可多个） |
| `/root/koishi-app/data/nickname-collections.json` | 昵称/集合数据（自动生成） |
| `/root/bilibili-cookies.txt` | B站 Cookie（视频插件用） |
| `/root/koishi-bili-downloads/` | 视频临时下载目录（自动清理） |
| `/root/koishi-app/koishi.yml` | Koishi 主配置 |

---

## 八、黑名单群管理

`name.md` 和 `vedio.md` 各自有一个 `GROUP_BLACKLIST`，在文件顶部常量位置修改，格式：

```javascript
const GROUP_BLACKLIST = new Set([
  '942033342',
  // '其他群号',
])
```

修改后重新执行对应脚本 + 重启 Koishi 生效。

---

## 九、常见问题

**Q：昵称/集合指令完全没有反应**  
A：检查 `koishi.yml` 是否有 `group-name-at: {}`，以及 Koishi 日志是否有 loaded 字样。群号是否在黑名单里。

**Q：AI 随机触发率太低**  
A：在服务器 `/root/koishi-app/` 新建 `.env` 文件写 `AI_RANDOM_TRIGGER_RATE=0.05` 提高触发率，重启生效。

**Q：视频下载失败**  
A：先手动测试：`yt-dlp --cookies /root/bilibili-cookies.txt "https://B站链接"`，确认 yt-dlp 和 Cookie 正常。

**Q：想改某个插件里的参数但不想重部署全部**  
A：只需要重新执行对应那一个 `.md` 文件的内容，然后 `pm2 restart koishi` 即可。其他插件不受影响。
