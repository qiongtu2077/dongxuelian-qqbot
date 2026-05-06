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
| `指令速查.md` | 指令语法说明 |
| `进度.md` | 变更记录、规范、交接说明 |
| `教程.md` | 面向使用者的补充教程 |
| `scripts/*.sh` | 可直接在 Linux 服务器执行的部署脚本 |
| `scripts/deploy-and-restart.bat` | Windows 一键部署+重启脚本 |
| `packages/koishi-plugin-dashboard/` | Dashboard 独立服务器 + 一键部署面板 |
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

## 三、快速部署顺序（一图看懂）

按下面顺序做，**前一步没成功就不要做下一步**：

| 步骤 | 做什么 | 怎么算成功 |
|------|--------|------------|
| 1 | 准备一台 Linux 服务器（root） | 能 `ssh root@IP` 登录 |
| 2 | 装 Node.js 18+ | `node -v` 显示 `v18.x.x` 或更高 |
| 3 | 装并登录 NapCat | NapCat 页面里 QQ 显示已登录 |
| 4 | 在 NapCat 里开启正向 WebSocket，端口 8080 | 在服务器上 `ss -ltnp \| grep 8080` 能看到监听 |
| 5 | 在服务器建好 Koishi 工程并写 `koishi.yml` | `cd /root/koishi-app && node .` 不报错 |
| 6 | 复制本仓库 `scripts/*.sh` 到服务器执行 | 群里发 `help东雪莲` 有响应 |

下面每一步都给出可直接复制粘贴的命令。

---

## 四、第 1~2 步：服务器与 Node.js

> 假设：服务器系统是 Ubuntu 22.04 / Debian 12 / CentOS 7+ / Rocky Linux 9，并且你以 `root` 登录。

### 4.1 用 SSH 登录服务器

在你本机（Windows PowerShell 或 macOS/Linux 终端）执行：

```bash
ssh root@你的服务器公网IP
```

后面所有命令都在服务器上执行，不在本机。

### 4.2 安装 Node.js 18

**Ubuntu / Debian：**

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
```

**CentOS / Rocky：**

```bash
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs
```

### 4.3 验证版本

```bash
node -v
npm -v
```

要求：`node -v` 不能低于 `v18.0.0`，否则后续 koishi 会报错。

---

## 五、第 3~4 步：装 NapCat 并打开 OneBot 端口

NapCat 负责把 QQ 消息转成 OneBot 协议。**必须先把 NapCat 跑通，再去做 Koishi。**

### 5.1 安装 NapCat（推荐用官方一键脚本）

```bash
curl -o napcat.sh https://nclatest.znin.net/NapNeko/NapCat-Installer/main/script/install.sh
bash napcat.sh
```

> 如果上面的镜像访问不了，去 NapCat 官方仓库找最新一键脚本：<https://github.com/NapNeko/NapCatQQ>。

安装完成后会有 NapCat 管理页面，常见地址是：

```
http://你的服务器IP:6099
```

第一次访问会让你设置后台管理密码，请记住。

### 5.2 在 NapCat 里登录 QQ

1. 打开管理页面 `http://你的服务器IP:6099`，登录后台。
2. 添加机器人 QQ 号 → 选择**扫码登录**。
3. 用机器人那个 QQ 号扫码（不是你自己的常用号）。
4. 看到状态变成「已登录」才算成功。

### 5.3 打开正向 WebSocket（给 Koishi 用）

在 NapCat 管理页面 → 「网络配置」 → 添加一个 **WebSocket 服务器（正向）** ，参数如下：

| 项目 | 值 |
|------|----|
| 启用 | 是 |
| 主机 | `0.0.0.0` |
| 端口 | `8080` |
| 路径 | `/onebot/v11/ws` |
| 心跳间隔 | 默认即可 |
| Access Token | 留空（或你自己设一个，但 koishi.yml 里要一致） |

保存配置。

### 5.4 验证 OneBot 端口确实在监听

在服务器执行：

```bash
ss -ltnp | grep 8080
```

如果**没有任何输出**，说明 NapCat 没把端口暴露出来，回到 5.3 检查。  
看到一行类似 `LISTEN 0 511 *:8080 *:*` 才算通。

> 经验提醒：如果用阿里云 / 腾讯云，**安全组里也要放行 8080 给本机**（Koishi 在同一台机器上就不用对外开）。

---

## 六、第 5 步：搭建 Koishi 工程

### 6.1 建目录、初始化 npm

```bash
mkdir -p /root/koishi-app/data
chmod 700 /root/koishi-app/data
cd /root/koishi-app
npm init -y
```

### 6.2 安装核心依赖

```bash
cd /root/koishi-app
npm install koishi @koishijs/plugin-server koishi-plugin-adapter-onebot
```

### 6.3 写入最小可用的 `koishi.yml`

直接把下面这一段整段粘到服务器终端，按回车，它会自动创建文件：

```bash
cat > /root/koishi-app/koishi.yml <<'EOF'
plugins:
  server:
    port: 5140
    selfUrl: http://localhost:5140
  adapter-onebot:
    protocol: ws
    selfId: '机器人QQ号'
    endpoint: ws://127.0.0.1:8080/onebot/v11/ws
EOF
```

然后**只改一行**：把 `selfId` 里的 `机器人QQ号` 替换成你在 NapCat 登录的那个 QQ 号。命令版替换：

```bash
sed -i "s/机器人QQ号/3651312852/" /root/koishi-app/koishi.yml
```

> 把 `3651312852` 换成你自己的机器人 QQ 号。

如果你在 NapCat 5.3 给 WebSocket 设了 Access Token，要在 `endpoint` 同级加一行 `token: '你的Token'`。

### 6.4 试启动一次

```bash
cd /root/koishi-app
node .
```

观察日志，应该看到类似：

```
[server] server started at http://localhost:5140
[onebot] connect to ws://127.0.0.1:8080/onebot/v11/ws
[onebot] connected to bot 3651312852
```

看到 `connected to bot` 才算 Koishi ↔ NapCat 跑通。  
**没看到这一行**就先回 NapCat 检查 8080，不要继续往下做。

按 `Ctrl + C` 停掉，准备装插件。

---

## 七、第 6 步：部署本仓库的插件脚本

> 本仓库的部署形态是：**每个插件对应一个 `scripts/*.sh`**。  
> 现在脚本不再内嵌旧版插件源码，而是从仓库里的 `packages/*` 同步当前插件代码到服务器。
> 执行脚本前需要先把本仓库同步到服务器，并在仓库根目录运行对应脚本。

### 7.1 通用执行流程（每个 sh 都这样做）

1. 先把仓库同步到服务器，例如放在 `/root/koishi-app/repo`。
2. SSH 到服务器后进入仓库根目录：`cd /root/koishi-app/repo`。
3. 执行对应脚本，例如：`sh scripts/help.sh`。
4. 脚本会把 `packages/对应插件` 复制到 `/root/koishi-app/node_modules/`，并把插件加进 `koishi.yml`。
5. 看到脚本最后输出 `Installed koishi-plugin-xxxxx` 即视为成功。

> 注意：默认 Koishi 目录仍是 `/root/koishi-app`。如果你的 Koishi 装在其他目录，可以这样执行：`KOISHI_APP_DIR=/你的/koishi目录 sh scripts/help.sh`。

按下面顺序做。**每装完一个就重启一次 Koishi 看日志。**

### 7.2 安装顺序

| 序 | 脚本 | 必装？ | 群内验证指令 | 备注 |
|----|------|--------|--------------|------|
| 1 | `scripts/help.sh` | 是 | `help东雪莲` | 帮助菜单，最容易验证整套是否通 |
| 2 | `scripts/name.sh` | 是 | `查看全部昵称` | 昵称 / 集合 / `at昵称` |
| 3 | `scripts/leave.sh` | 否 | 让小号退群试试 | 群退人提醒 |
| 4 | `scripts/poke.sh` | 否 | 戳一戳机器人 | 戳一戳反击 |
| 5 | `scripts/defense.sh` | 否 | 群里说「你是什么模式」 | 反越狱防护 |
| 6 | `scripts/vedio.sh` | 否 | 发 B 站链接 | 见 7.3 视频插件预备 |
| 7 | `scripts/ai.sh` | 否 | `@东雪莲 你是谁` | 见 7.4 AI 插件预备 |
| 8 | `scripts/message-reader.sh` | 否（仅 ai 联用） | — | 兼容旧入口；现在会部署完整 AI 插件 |

> `help.sh`、`name.sh`、`leave.sh`、`poke.sh`、`defense.sh` 都没有额外运行依赖，但需要从仓库根目录执行。
> `vedio.sh`、`ai.sh` **必须**先按 7.3、7.4 准备好依赖文件，否则跑起来会缺东西。

### 7.3 视频插件部署前的准备（执行 `vedio.sh` 之前必看）

#### 7.3.1 在服务器装 yt-dlp

```bash
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
yt-dlp --version
```

最后一行能输出版本号才算通。

#### 7.3.2 在服务器装 ffmpeg

Ubuntu / Debian：

```bash
apt-get install -y ffmpeg
```

CentOS / Rocky：

```bash
yum install -y epel-release
yum install -y ffmpeg
```

验证：

```bash
ffmpeg -version
```

#### 7.3.3 准备 B 站 cookies（在你本机做）

1. 在浏览器装 **「Get cookies.txt LOCALLY」** 之类的扩展，登录 b 站。
2. 打开 `https://www.bilibili.com`，点击扩展，导出 `cookies.txt`。
3. 在你**本机** PowerShell 里把它上传到服务器：

```powershell
scp .\cookies.txt root@你的服务器IP:/root/bilibili-cookies.txt
```

> 注意路径一定是 `/root/bilibili-cookies.txt`，脚本写死了这个位置。

#### 7.3.4 然后再粘 `scripts/vedio.sh`

按 7.1 的流程执行。

### 7.4 AI 插件部署前的准备（执行 `ai.sh` 之前必看）

`ai.sh` 启动时会读三个文件，缺一不可。**先把三个文件写好，再粘脚本。**

```bash
mkdir -p /root/koishi-app/data
chmod 700 /root/koishi-app/data
```

#### 7.4.1 API Key

把 `sk-你的APIKey` 换成你真实的 Key（**不要把引号也粘进去**）：

```bash
echo 'sk-你的APIKey' > /root/koishi-app/data/ai-openai-key.txt
chmod 600 /root/koishi-app/data/ai-openai-key.txt
```

#### 7.4.2 模型名

```bash
echo 'qwen-plus' > /root/koishi-app/data/ai-model.txt
```

> 阿里云用 `qwen-plus`、`qwen3.5-plus`；DeepSeek 官方用 `deepseek-chat`；OpenAI 用 `gpt-4o-mini`。  
> 这一步的模型名要和下一步的 base url **配套**。

#### 7.4.3 Base URL

阿里云（DashScope OpenAI 兼容模式）：

```bash
echo 'https://dashscope.aliyuncs.com/compatible-mode/v1' > /root/koishi-app/data/ai-base-url.txt
```

DeepSeek 官方：

```bash
echo 'https://api.deepseek.com' > /root/koishi-app/data/ai-base-url.txt
```

OpenAI 官方：

```bash
echo 'https://api.openai.com/v1' > /root/koishi-app/data/ai-base-url.txt
```

#### 7.4.4 （可选）Skill 目录

```bash
mkdir -p /root/koishi-app/data/ai-skills
```

后面想给 AI 加额外提示词，把 `*.md` 丢这个目录即可。

#### 7.4.5 然后再粘 `scripts/ai.sh`

按 7.1 的流程执行。

---

## 八、启动与守护

### 8.1 临时跑（前台，调试用）

```bash
cd /root/koishi-app
node .
```

按 `Ctrl + C` 退出。

### 8.2 用 pm2 后台跑（推荐）

只需一次安装：

```bash
npm install -g pm2
```

每次启动：

```bash
cd /root/koishi-app
pm2 start "node ." --name koishi
pm2 save
pm2 startup    # 按提示再执行它打印出来的那条命令，让 pm2 开机自启
```

常用操作：

```bash
pm2 logs koishi          # 查日志
pm2 restart koishi       # 重启
pm2 stop koishi          # 停止
pm2 status               # 查状态
```

### 8.3 改了 `koishi.yml` 或装了新插件之后

```bash
pm2 restart koishi
pm2 logs koishi
```

看到 `xxx loaded` 才算插件生效。

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

- `README.md / 指令速查.md / 进度.md`：中文文档层
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
| `helpAI` | 查看 AI 帮助 |
| `help集合` | 查看集合帮助 |
| `指令速查` | 查看一页版速查 |

### AI

| 指令 | 说明 |
|------|------|
| `AI状态` | 查看 AI 当前配置摘要 |
| `AI重载` | 重载 AI 配置与 Skills，仅限管理员 |
| `@东雪莲 ...` | 直接触发 AI 回复 |
| `东雪莲联网开/关/查看` | 联网开关，仅限管理员 |
| `东雪莲群聊AI概率设置/重置/查看` | 调整群聊主动回复概率，仅限管理员 |
| `群聊AI白名单添加/删除/查看` | 管理主动回复白名单，仅限管理员 |

---

## 十二、维护说明

如果你要继续维护这个仓库，建议遵守以下原则：

- 部署脚本保持“只做部署，不内嵌插件业务源码”
- 解释、约束、交接统一写进 `进度.md`
- 先保证服务器可直接部署，再逐步整理源码结构
- 每次改动后同步检查版本号、安装提示和 `README`

当前仓库优先服务“能部署、能跑、能维护”，不是做成一个空壳模板仓库。

---

## 十三、Dashboard 一键部署面板

Dashboard（`packages/koishi-plugin-dashboard/`）自带一键部署面板，可在浏览器中配置远程服务器信息并执行部署。

### 启动本地 Dashboard

```bash
cd packages/koishi-plugin-dashboard
node standalone.js
```

浏览器打开 `http://localhost:5150/dashboard/`，进入「部署」Tab。

### 部署配置

| 字段 | 说明 |
|------|------|
| 服务器地址 | `root@服务器IP` 格式 |
| 应用目录 | 远程服务器上的 Koishi 应用目录（默认 `/root/koishi-app`） |
| 访问密码 / 管理员密码 | 部署到新服务器时设置（留空使用默认密码 `123456`） |
| B 站 Cookies | 可选，视频插件需要，从浏览器导出的 `cookies.txt` |

### 部署流程

1. 填写服务器地址 → 保存配置
2. （可选）上传 B 站 Cookies、设置密码
3. 点「开始部署」→ 实时查看部署日志
4. 部署完成后点「打开已部署面板」进入远程服务器的 Dashboard

### 部署内容

一键部署自动推送：

- 所有插件 `lib/` 代码 + `package.json`
- Dashboard `standalone.js` + 前端 `dist/`
- `ai-skills/` 数据文件
- API Key 等配置文件
- `restart.sh` + `watchdog.sh` 脚本
- 自动安装 `yt-dlp`（视频插件依赖）
- 自动创建 `/root/koishi-bili-downloads` 目录

### 密码安全

部署面板中的密码设置只对**目标服务器**生效（通过 SSH 写入远端文件），不影响当前运行中的 Dashboard。如已在服务器上手动改过密码，部署时不会覆盖。

