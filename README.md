# 东雪莲QQBot-极致嘴臭

本项目是一套基于 `Koishi + NapCat + OneBot` 的 QQ 机器人部署仓库，当前采用 `md + sh + js` 共存结构，主要目标是：

- 给普通用户一套能直接复制到服务器执行的部署脚本
- 给维护者保留清晰的插件边界、部署顺序和文档说明
- 逐步从“脚本集合”整理成“脚本交付 + 标准源码结构”并存的项目

如果你只想把机器人跑起来，看“快速部署”。
不会的直接问AI，下次还填非常简单  
如果你关心仓库为什么不是全 `.sh`、为什么要保留 `.md` 和 `.js`，看标题十。

---

## 一、当前仓库结构

| 路径 | 作用 |
|------|------|
| `README.md` | 中文总说明与部署入口 |
| `语法.md` | 指令语法说明 |
| `进度.md` | 变更记录、规范、交接说明 |
| `教程.md` | 面向使用者的补充教程 |
| `scripts/*.sh` | 可直接在 Linux 服务器执行的部署脚本 |
| `packages/*/lib/index.js` | 各插件当前可运行的 JS 代码 |
| `packages/*/package.json` | 各插件的标准包信息 |
| `package.json` | 仓库根配置，声明 workspaces |

当前分工是：

- 中文 `md`：保留文档、说明、教程、交接
- `sh`：保留可直接执行的部署脚本
- `js`：保留真正的插件逻辑代码

这样既能快速部署，也比“全部代码塞进 Markdown”更容易 review 和维护。

---

## 二、整体架构

机器人消息链路如下：

1. `NapCat` 登录 QQ，并把消息通过 `OneBot` 协议暴露出来
2. `Koishi` 作为机器人框架接收 `NapCat` 的消息
3. 本仓库里的各插件挂到 `Koishi` 上，负责昵称、帮助、AI、视频、退群提醒等功能

也就是说：

- `NapCat` 负责“连 QQ”
- `Koishi` 负责“跑插件”
- 本仓库负责“部署这些插件”

如果没有先把 `NapCat` 跑起来，后面的 `Koishi` 和插件都无法正常收发消息。

---

## 三、快速部署顺序

推荐按下面顺序部署：

1. 准备 Linux 服务器
2. 部署 `NapCat`
3. 部署 `Koishi`
4. 执行本仓库的插件部署脚本
5. 验证日志和群内指令

---

## 四、服务器准备

建议环境：

- 系统：`Ubuntu 22.04+` 或 `CentOS 7+/Rocky Linux`
- Node.js：`18+`
- 权限：建议用 `root`

安装 Node.js 示例：

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# CentOS / Rocky
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs
```

确认版本：

```bash
node -v
npm -v
```

---

## 五、部署 NapCat

NapCat 是 QQ 登录和 OneBot 消息入口，必须先装。

### 1. 准备 NapCat

请按 NapCat 官方方式安装。你可以用 Docker，也可以直接跑官方包。  
核心目标只有两个：

- QQ 成功登录
- OneBot 接口能对本机 `Koishi` 提供连接

### 2. 配置 OneBot

你至少要确认这几项：

- 协议版本：`OneBot v11`
- 通信方式：`WebSocket Reverse` 或 NapCat 对应的反向 WS
- 监听地址或回连地址正确
- 机器人 QQ 号填写正确

如果你打算让 `Koishi` 本机接收消息，常见形态类似：

- NapCat 在本机某端口暴露 OneBot
- Koishi 通过 `adapter-onebot` 去连

### 3. 先验证 NapCat 是否正常

在继续之前，先确保：

- QQ 已经登录
- NapCat 页面状态正常
- OneBot 配置已保存
- 端口确实在监听

如果 NapCat 没通，后面所有插件都白装。

---

## 六、部署 Koishi

### 1. 初始化目录

```bash
mkdir -p /root/koishi-app
cd /root/koishi-app
npm init -y
npm install koishi
```

### 2. 创建最小 `koishi.yml`

下面给一个最小示例，实际参数请按你的 NapCat 配置调整：

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

如果你的 NapCat 不是这个地址，就把 `endpoint` 改成你自己的。

### 3. 先单独启动一次 Koishi

```bash
cd /root/koishi-app
node .
```

先看它能不能正常读到配置、有没有明显报错。  
确认没问题后，再继续部署插件。

---

## 七、部署本仓库插件

这一步是本仓库的核心使用方式。  
当前推荐直接执行 `scripts/` 里的 `.sh` 文件。

统一流程如下：

1. 在本地打开对应 `scripts/*.sh`
2. 全选
3. 复制
4. 粘贴到服务器终端
5. 回车执行
6. 等待脚本写入插件文件并重启 / 注册到 `koishi.yml`

### 1. 昵称 / 集合插件

执行 `scripts/name.sh`

作用：

- 绑定昵称
- 创建集合
- `at昵称` / `at集合`

### 2. 帮助菜单插件

执行 `scripts/help.sh`

作用：

- `help东雪莲`
- `help集合`

### 3. 退群提醒插件

执行 `scripts/leave.sh`

作用：

- 群成员退出时发送提醒

### 4. 视频插件

执行 `scripts/vedio.sh` 之前，需要准备：

#### 安装 `yt-dlp`

```bash
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
```

#### 安装 `ffmpeg`

```bash
# Ubuntu / Debian
apt-get install -y ffmpeg

# CentOS / Rocky
yum install -y ffmpeg
```

#### 准备 B 站 cookies
先使用浏览器插件cookies获取b站cookies
导出 `cookies.txt` 后上传到服务器：

```powershell
scp cookies.txt root@你的服务器IP:/root/bilibili-cookies.txt
```

然后执行 `scripts/vedio.sh`。

### 5. AI 插件

执行 `scripts/ai.sh` 之前，需要先准备配置文件：

#### API Key

```bash
mkdir -p /root/koishi-app/data
echo "sk-你的APIKey" > /root/koishi-app/data/ai-openai-key.txt
```

#### 模型名

```bash
echo "qwen-plus" > /root/koishi-app/data/ai-model.txt
```

#### Base URL

```bash
echo "https://dashscope.aliyuncs.com/compatible-mode/v1" > /root/koishi-app/data/ai-base-url.txt
```

#### 可选 Skill

```bash
mkdir -p /root/koishi-app/data/ai-skills
```

把 `SKILL.md` 类文件放到这个目录即可。

然后执行 `scripts/ai.sh`。

---

## 八、推荐启动方式

### 临时测试

```bash
cd /root/koishi-app
node .
```

### 后台运行

```bash
npm install -g pm2
cd /root/koishi-app
pm2 start "node ." --name koishi
pm2 save
pm2 startup
```

### 重启

```bash
pm2 restart koishi
```

---

## 九、如何验证是否部署成功

先看日志里有没有这些关键词（不过我一般不看）：

```text
group-name-at loaded
dongxuelian-help loaded
dongxuelian-ai loaded
local-video-sender loaded
group-leave-notice loaded
```

再去群里做简单验证：

- `help东雪莲`
- `help集合`
- `查看全部昵称`
- `AI状态`

如果某个插件没加载，优先检查：

- `koishi.yml` 里有没有对应插件配置
- 对应脚本有没有执行完整
- 服务器上插件目录有没有被正确写入

---

## 十、常见问题

### 1. 为什么现在是 `md + sh + js` 共存？

因为本仓库当前同时服务两类人：

- 只想把机器人快速跑起来的实际使用者
- 需要继续维护、排错、迭代插件的维护者

现在的折中方案是：

- 中文说明留在 `md`
- 部署动作留在 `sh`
- 插件本体逻辑留在 `js`

这样不会把所有东西都混成一种文件。

### 2. 为什么不全都写成 `.sh`？

不是不能写成 `.sh`，而是职责不同。

`sh` 更适合做这些事：

- 建目录
- 写文件
- 拷贝产物
- 重启服务
- 改配置文件

但插件本体逻辑不是 shell 擅长的领域。像这些内容更适合用 `js/ts`：

- 消息解析
- AI 对话逻辑
- OneBot / Koishi 插件处理
- 上下文记忆
- 越狱检测
- 重复回复检测

所以更合理的分工其实是：

- `.sh`：部署层
- `.js/.ts`：插件逻辑层
- `.md`：中文文档、部署教程、交接记录

本仓库现在已经开始拆分：

- 保留 `scripts/*.sh` 作为部署入口
- 保留 `packages/*` 作为代码入口
- 保留中文 `md` 作为说明入口

### 3. 我是否应该把这些都改成 `.ts`？

如果后面要长期维护，当然可以逐步迁移到 `ts`。  
但当前先保留 `js` 有两个现实原因：

- 服务器最终运行的还是 `js`
- 当前仓库先把“结构拆开”比“立刻全量 TS 化”更重要

后续更合理的路线是：

- 先稳定 `sh + js + md`
- 再逐步补 `src/*.ts`
- 最后用构建产物生成 `lib/index.js`

### 4. 这个仓库以后应该往哪里整理？

建议最终整理成三层：

- `README.md / 语法.md / 进度.md`：中文文档层
- `scripts/*.sh`：部署执行层
- `packages/*`：代码维护层

这样既不牺牲部署效率，也能提升可维护性。

---

## 十一、常用指令速查

### 昵称 / 集合

| 指令 | 说明 |
|------|------|
| `@A用户 昵称 名字` | 绑定昵称 |
| `查看昵称 名字` | 查看昵称绑定的成员 |
| `查看成员 @A用户` | 查看某人的所有昵称 / 集合 |
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
| `at昵称` / `at集合` | 批量艾特 |

### 帮助

| 指令 | 说明 |
|------|------|
| `help东雪莲` | 查看总帮助 |
| `help集合` | 查看集合帮助 |

### AI

| 指令 | 说明 |
|------|------|
| `AI状态` | 查看 AI 当前配置摘要 |
| `AI重载` | 重载 AI 配置与 Skills |
| `@东雪莲 ...` | 直接触发 AI 回复 |

---

## 十二、维护说明

如果你要继续维护这个仓库，建议遵守以下原则：

- 部署脚本保持“纯可执行内容”
- 解释、约束、交接统一写进 `进度.md`
- 先保证服务器可直接部署，再逐步整理源码结构
- 每次改动后同步检查版本号、安装提示和 `README`

当前仓库优先服务“能部署、能跑、能维护”，不是做成一个空壳模板仓库。
