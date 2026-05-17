# LianLianBot 测试手册

> 2026-05-17 更新：项目文档定位统一为 LianLianBot；测试范围同步覆盖 Agent Console、Agent 工具、Skill 市场、自动记忆/梦境、语音 ASR/TTS、浏览器/搜索工具、图集/闪卡效果和部署诊断。运行任何 Python 脚本前必须先确认并激活项目 Conda 环境；当前手册默认只列 Node/npm 命令。

## 快速命令

```bash
# 完整测试（推荐）
node packages/koishi-plugin-dongxuelian-ai/test/cascade-test.js

# 仅模块加载
node -e "
['constants','utils','persona','api','conversation'].forEach(f=>{
  try{require('./packages/koishi-plugin-dongxuelian-ai/lib/'+f);console.log('✓',f)}
  catch(e){console.log('✗',f,e.message)}
});
try{require('./packages/koishi-plugin-dongxuelian-help/lib/index');console.log('✓ help')}
catch(e){console.log('✗ help',e.message)}
"
```

---

## 一、回归测试

每次修改 `index.js` / 拆分文件后，必须跑完整回归。

### 1.1 模块加载完整性

验证 6 个拆分文件 + help 插件全部可加载、无 require 循环：

| 模块 | 文件 | 依赖 |
|---|---|---|
| constants | `lib/constants.js` | 无 |
| utils | `lib/utils.js` | 无 |
| persona | `lib/persona.js` | constants |
| api | `lib/api.js` | constants, path, fs |
| conversation | `lib/conversation.js` | constants, utils, path, fs |
| main | `lib/index.js` | 以上全部 + message-reader |
| help | `dongxuelian-help/lib/index.js` | fs, path |

**检查项**：
- [ ] 6 个文件 require 无报错
- [ ] help 插件 require 无报错
- [ ] 无 "Circular dependency" 警告

### 1.2 函数去重检查

确保拆分后无重复定义（同一函数名出现在多个文件中是非法的，除非是不同签名）：

```bash
node -e "
const dir='packages/koishi-plugin-dongxuelian-ai/lib';
const files=['index.js','constants.js','utils.js','persona.js','api.js','conversation.js'];
const all=[];
const {execSync}=require('child_process');
for(const f of files){
  const content=require('fs').readFileSync(dir+'/'+f,'utf8');
  const funcs=[...content.matchAll(/(?:^(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\(\)\s*=>))/gm)];
  for(const m of funcs) all.push({name:m[1]||m[2],file:f,line:content.substr(0,m.index).split('\\n').length});
}
const names=[];
const dups=all.filter(a=>{if(names.includes(a.name))return true;names.push(a.name);return false});
if(dups.length){
  console.log('重复函数：');
  for(const d of dups)console.log('  '+d.name+' ('+d.file+':'+d.line+')');
}else{
  const total=all.length;
  console.log('通过：'+total+' 个函数，无重复');
}
"
```

- [ ] 无重复函数定义
- [ ] 总数 ≈ 124（当前基准线）

### 1.3 常量完整性

关键常量必须同时存在于 `constants.js` —— 修改时检查：

```bash
node -e "
const c=require('./packages/koishi-plugin-dongxuelian-ai/lib/constants');
['DATA_DIR','PLUGIN_VERSION','KEY_FILE','MODEL_FILE','BASE_URL_FILE',
 'SKILLS_DIR','SKILLS_CORE_DIR','SKILLS_MODES_DIR','SKILLS_PERSONAS_DIR','SKILLS_LORE_DIR',
 'LORE_TRIGGER_REGEX','SMART_MODE_OVERRIDE_KEYWORDS','PROVIDERS','BLACKLIST_ALLOWED_EXT',
 'REPEAT_DETECT_WINDOW','REPEAT_DETECT_COUNT','SENSITIVE_KEYWORDS','USER_PROFILE_PROMPT',
 'POLITICAL_KEYWORDS','TABOO_KEYWORDS','POEM_NAMES','PERSONA_NAMES','MAX_GROUPS','DEFAULT_SYSTEM_PROMPT',
 'CHARS_THRESHOLD','LINES_THRESHOLD','SUMMARY_TRIGGER_LENGTH','SUMMARY_TARGET_LENGTH',
 'DEFAULT_MODEL','DEFAULT_BASE_URL','DEFAULT_TEMPERATURE','DEFAULT_FREQUENCY_PENALTY',
 'DEFAULT_MAX_TOKENS','DEFAULT_CONTEXT_SIZE','FALLBACK_TIMEOUT','PRIMARY_TIMEOUT'].forEach(k=>{
  if(c[k]===undefined)console.log('缺失:',k);
});
console.log('常量检查完成');
"
```

- [ ] 所有关键常量已定义

---

## 二、单元测试（核心函数）

### 2.1 splitSentences

**位置**：`utils.js`

**作用**：按中文标点拆句，同时保留 emoji / 特殊符号作为新句开头。

| 输入 | 预期输出 |
|---|---|
| `"你好。世界！"` | `["你好。", "世界！"]` |
| `"嘿嘿～让我想想"` | `["嘿嘿～", "让我想想"]` |
| `"A：哈哈 B：嘿嘿"` | `["A：", "哈哈 B：", "嘿嘿"]` (视具体实现) |
| `"测试😊继续"` | `["测试😊", "继续"]` (如果处理 emoji) |

### 2.2 normalizeText（来自 message-reader.js）

**注意**：此函数不在 `utils.js`，而是从 `./message-reader` 导入。

**作用**：标准化用户输入（去除 null 字符、全角转半角、替换特殊空格）。

### 2.3 buildFallbackConfig

**位置**：`api.js`

**作用**：401/429/400 → 尝试下一个供应商。

**验证方法**：临时修改 key 为错误值，触发 401，确认 fallback 到下一家。

### 2.4 getPersonaPrompt / getModePrompt / getLoreTrigger

**位置**：`persona.js`

**验证**：

- [ ] `getPersonaPrompt('长离')` 返回长离的 SKILL 内容
- [ ] `getLoreTrigger(userId, guildId)` 返回非空（有配置时）
- [ ] 人格不存在时返回空字符串，不抛异常

### 2.5 getConversationSummary / saveSharedChannelTurn

**位置**：`conversation.js`

- [ ] 摘要生成时不包含 "我给你总结一下聊天记录" 之外的额外语句
- [ ] `saveSharedChannelTurn` 写入文件路径正确（DATA_DIR/turns/...）

### 2.6 敏感检测

**位置**：`conversation.js` 或 `index.js` 中的 `checkSensitive`

- [ ] 命中 `SENSITIVE_KEYWORDS` 时返回 true，发送警告
- [ ] 未命中时正常放行
- [ ] 敏感处理者（SENSITIVE_HANDLERS）收到转发通知

---

## 三、集成测试（需运行 bot）

### 3.1 模块加载日志检查

启动 bot，观察控制台：

```
[I] dongxuelian-ai loaded    ← 必须出现
```

如果出现 `ReferenceError: xxx is not defined` 说明拆分遗漏了某个顶层定义。

### 3.2 基础聊天（无@）

**测法**：在群里随便发一句话，观察日志：

```
random-reply debug: key=xxx whitelist=false candidate=false triggered=... rate=0.00001
```

- `triggered=false, skip=false` → 正常未触发随机回复
- 如果 `triggered=true` 说明概率命中，是正常行为
- 如果有 `skip=true` 且原因合理（非 @ 无白名单则 skip 是正常的）

### 3.3 @ 回复

**测法**：`@东雪莲 你好`，观察日志链路：

1. `entry-debug: userId=xxx isDirect=true` → 入口命中
2. `middleware-debug: plain="你好"` → 文本提取
3. `persona-check: plain="你好"` → 人格检测（若开启）
4. `chat() begin` → 进入聊天
5. `conversation loaded: xxx messages` → 上下文加载
6. `requestChatCompletions begin` → 请求大模型
7. `requestChatCompletions fallback to xxx` → fallback（如果有）

**目标**：看到完整链路，最终群里有回复。

### 3.4 测试模式

**测法**：`东雪莲测试开` → 然后 `@东雪莲 你好`，日志应看到：

```
test-mode: 跳过实际API调用，返回预设回复
```

群里应看到预设回复（通常是 "测试回复"）。

`东雪莲测试关` 恢复正常。

### 3.5 复读检测

**测法**：连续发相同消息 3+ 次，日志：

```
repeat-detected: 跳过复读
```

`东雪莲复读开` / `东雪莲复读关` / `东雪莲复读状态` 查看当前设置。

### 3.6 敏感话题检测

**测法**：发送命中 `SENSITIVE_KEYWORDS` 的消息。

- [ ] bot 给出警告
- [ ] 敏感处理者收到转发
- [ ] 日志记录 `sensitive-topic: xxx`

### 3.7 人格切换

**测法**：

```
东雪莲我的人格        → 显示当前人格
东雪莲人格列表        → 列出可用人格（已删除 ← 你的当前）
东雪莲人格切换 长离    → 切换到长离
东雪莲人格重置         → 重置为默认
东雪莲群人格          → 显示群人格（管理员）
东雪莲群人格切换 椿    → 切换群人格（管理员）
```

- [ ] 切换后回复风格变化
- [ ] 群人格不影响用户人格（两者独立）
- [ ] `东雪莲人格列表` 不再显示 `← 你的当前`

### 3.8 今日情绪

**测法**：`今日情绪`

- [ ] 输出包含 5 天对比：`📅 **5天对比：**`（最早在第 5 天起出现）
- [ ] 情绪值在合理范围（-10 ~ 10，通常 -5 ~ 5）
- [ ] 没有多余空行或乱码

### 3.9 help 菜单

**测法**：`helpAI`

- [ ] 所有命令分类清晰可读
- [ ] 无乱码 / 格式错乱
- [ ] 无断句异常（splitSentences 不干扰）

---

## 四、服务端部署测试

### 4.1 文件传输

```bash
# 上传 JS 文件
scp packages/koishi-plugin-dongxuelian-ai/lib/*.js root@YOUR_SERVER_IP:/root/koishi-app/packages/koishi-plugin-dongxuelian-ai/lib/
scp packages/koishi-plugin-dongxuelian-help/lib/index.js root@YOUR_SERVER_IP:/root/koishi-app/packages/koishi-plugin-dongxuelian-help/lib/index.js

# 上传 SKILL 文件
scp packages/koishi-plugin-dongxuelian-ai/data/ai-skills/core/SKILL.persona-core.md root@YOUR_SERVER_IP:/root/koishi-app/data/ai-skills/core/
scp packages/koishi-plugin-dongxuelian-ai/data/ai-skills/personas/SKILL.长离.md root@YOUR_SERVER_IP:/root/koishi-app/data/ai-skills/personas/
scp "E:\莲莲Bot\packages\koishi-plugin-dongxuelian-ai\data\ai-skills\personas\SKILL.椿.md" root@YOUR_SERVER_IP:/root/koishi-app/data/ai-skills/personas/
```

**注意**：Windows 路径含空格/中文时用双引号包裹。SCP 在 PowerShell 不支持 `&&`，用 `;` 分隔。

### 4.2 编码检查

SCP 可能损坏中文字符（UTF-16→ASCII 问题）。上传后检查：

```bash
# 服务端检查 SKILL 文件编码
ssh root@YOUR_SERVER_IP "file /root/koishi-app/data/ai-skills/personas/SKILL.长离.md"
# 应输出: UTF-8 Unicode text
# 如果输出 "ASCII" 或 "data"，说明编码损坏，需要重新传

# 也可用 head 抽样
ssh root@YOUR_SERVER_IP "head -3 /root/koishi-app/data/ai-skills/core/SKILL.persona-core.md"
```

### 4.3 重启

```bash
# 杀旧进程（注意：pkill -f "start|koishi" 会误杀 SSH 守护进程！改用精确匹配）
ssh root@YOUR_SERVER_IP "pkill -f 'koishi/lib/worker' 2>/dev/null; sleep 3; cd /root/koishi-app && nohup npm exec koishi start >> koishi.log 2>&1 &"

# 等待 15 秒后检查
ssh root@YOUR_SERVER_IP "sleep 15 && tail -5 /root/koishi-app/koishi.log"
```

**预期输出**：
```
[I] dongxuelian-ai loaded
```

**如有异常**：
- `ReferenceError` → 本地没跑回归测试，合并时漏了变量定义
- `Error: Cannot find module` → SCP 传漏了文件
- 日志里只有旧时间戳 → 进程没重启成功，检查 `pkill` 是否命中

### 4.4 API Key 验证

| 供应商 | Key 前缀 | 文件位置 |
|---|---|---|
| mimorium | `tp-*` | `/root/koishi-app/data/keys/mimorium.ini` |
| opencode（deepseek） | `sk-*` | `/root/koishi-app/data/keys/opencode.ini` |
| dashscope（GLM/qwen） | `sk-*` | `/root/koishi-app/data/keys/dashscope.ini` |

上传本地文件到服务端时，**不要在 SCP 命令中用 PowerShell 管道编码**（如 `Get-Content ... | ssh ...` 会产生 UTF-16），直接用 `scp 源文件 user@host:目标路径`。

---

## 五、API Fallback 测试

### 5.1 正常链路

1. 主请求发往 `mimorium`（低延迟）
2. 如果 401（key 无效）→ fallback 到 `GLM`
3. 如果再 401 → fallback 到 `deepseek`
4. 如果还 401 → fallback 到 `qwen3.5` → `qwen3.6`

### 5.2 超时

- 主请求：40s 超时（`PRIMARY_TIMEOUT`）
- Fallback 请求：10s 超时（`FALLBACK_TIMEOUT`）
- 全部超时 → 回复 "服务器繁忙，请稍后再试"

### 5.3 测试方法

```bash
# 本地临时破坏 key 测试 fallback（记得恢复！）
echo "invalid-key" > data/keys/mimorium.ini
# 重启后 @bot 触发，观察日志应显示 fallback 到 GLM
# 测试完恢复：
echo "tp-xxxxx" > data/keys/mimorium.ini  # 替换为真实 key
```

---

## 六、人格 + SKILL 一致性

### 6.0 Agent / Skill / Voice 回归

当前新增能力优先跑轻量回归，再按风险补充场景测试：

```bash
npm run check
npm run test:quick
```

- Agent Console：确认 Dashboard 的 Agent 面板能打开，工具执行日志不会阻塞 Bot 主流程。
- Agent 工具：确认 `packages/koishi-plugin-dongxuelian-ai/lib/agent/` 下工具可加载，浏览器/搜索/文件类工具失败时有可读错误。
- Skill 市场：涉及技能市场或技能池时，补跑 `packages/koishi-plugin-dongxuelian-ai/test/scenarios/skill-market.test.js` 对应场景。
- 自动记忆/梦境：确认整理任务不会破坏现有上下文文件，失败时不影响普通聊天。
- 语音 ASR/TTS：确认语音识别或合成失败时能回退到文本回复，不吞掉原始错误日志。
- 图集/闪卡：确认上传、预览、A-G 样式和缓存刷新正常。

### 6.1 本地 vs 服务器 SKILL 一致

```bash
# 本地
md5sum packages/koishi-plugin-dongxuelian-ai/data/ai-skills/core/SKILL.persona-core.md
# 服务器
ssh root@YOUR_SERVER_IP "md5sum /root/koishi-app/data/ai-skills/core/SKILL.persona-core.md"
```

两边 MD5 应一致。

### 6.2 SKILL 文件目录结构

```
data/ai-skills/
├── core/
│   └── SKILL.persona-core.md       ← 核心规则（含括号约束）
├── modes/
│   └── SKILL.友好模式.md
├── personas/
│   ├── SKILL.长离.md
│   └── SKILL.椿.md
└── lore/
    └── ...（如果有）
```

**注意**：代码中 DATA_DIR 在 Windows 为 `lib/../data`，在 Linux 为 `/root/koishi-app/data`（硬编码）。

---

## 七、特殊注意事项

### 7.1 PowerShell 不兼容

- 不支持 `&&` 串联命令 → 改用 `;`
- 长命令换行用反引号 `` ` ``，不是 `\`
- 路径含空格必须双引号包裹
- `scp` 多个文件：每个文件单独一行，用 `;` 分隔

### 7.2 切勿误杀 SSH

```bash
# 错误 ❌ — 会杀 SSH 守护进程
pkill -f "start"

# 正确 ✅
pkill -f 'koishi/lib/worker'
```

### 7.3 Key 编码

- SCP 直接用二进制传输（推荐）
- 如果用 `ssh "echo key > file"` → 确保 key 字符串不含特殊 shell 字符
- 绝不用 `Get-Content file | ssh ... Set-Content` — 产生 UTF-16 BOM 导致 key 失效

### 7.4 备份

- 本地备份目录：`E:\莲莲Bot备份（无阴阳人格）\` — 包含所有备份版代码
- 此备份不含阴阳人格相关的功能，多轮对话 prompt 策略不同（更简洁）
- 回退方法：从备份目录复制对应文件覆盖 `lib/` 下文件

### 7.5 DEBUG 日志

日志前缀及含义：

| 前缀 | 含义 |
|---|---|
| `entry-debug` | 消息入口判断结果 |
| `middleware-debug` | 中间件提取的纯文本 |
| `persona-check` | 是否触发了人格检测 |
| `conversation loaded` | 载入的历史消息数 |
| `requestChatCompletions` | API 请求开始 |
| `requestChatCompletions fallback to` | 触发 fallback |
| `random-reply debug` | 随机回复概率判断 |
| `repeat-detected` | 复读检测触发 |
| `test-mode` | 测试模式生效 |
| `sensitive-topic` | 敏感话题命中 |

---

## 八、快速测试脚本

将以下内容保存为 `test/cascade-test.js`：

```javascript
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const LIB = path.join(ROOT, 'packages/koishi-plugin-dongxuelian-ai', 'lib')
const HELP = path.join(ROOT, 'packages/koishi-plugin-dongxuelian-help', 'lib')

const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'
let totalPassed = 0
let totalFailed = 0

function check(label, ok, detail) {
  if (ok) { totalPassed++; console.log(`  ${PASS} ${label}`) }
  else { totalFailed++; console.log(`  ${FAIL} ${label}${detail ? ': ' + detail : ''}`) }
}

// ===== 1. 模块加载 =====
console.log('\x1b[1m=== 模块加载 ===\x1b[0m')
const modPaths = {
  constants: path.join(LIB, 'constants'),
  utils: path.join(LIB, 'utils'),
  persona: path.join(LIB, 'persona'),
  api: path.join(LIB, 'api'),
  conversation: path.join(LIB, 'conversation'),
}
const loaded = {}
for (const [name, mp] of Object.entries(modPaths)) {
  try { loaded[name] = require(mp); check(name, true) }
  catch (e) { check(name, false, e.message) }
}
try { require(path.join(HELP, 'index')); check('help', true) }
catch (e) { check('help', false, e.message) }

// ===== 2. 函数去重 =====
console.log('\n\x1b[1m=== 函数去重 ===\x1b[0m')
const files = ['index.js', 'constants.js', 'utils.js', 'persona.js', 'api.js', 'conversation.js']
const all = []
for (const f of files) {
  const content = fs.readFileSync(path.join(LIB, f), 'utf8')
  const funcs = [...content.matchAll(/(?:^(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\(\)\s*=>))/gm)]
  for (const m of funcs) {
    const line = content.substring(0, m.index).split('\n').length
    all.push({ name: m[1] || m[2], file: f, line })
  }
}
const seen = {}
let dups = 0
for (const a of all) {
  if (seen[a.name]) {
    check(`重复: ${a.name}`, false, `${a.file}:${a.line} (已在 ${seen[a.name].file}:${seen[a.name].line})`)
    dups++
  }
  seen[a.name] = a
}
if (dups === 0) check(`${all.length} 个函数，无重复`, true)

// ===== 3. 常量完整性 =====
console.log('\n\x1b[1m=== 常量完整性 ===\x1b[0m')
const c = loaded.constants
const required = [
  'DATA_DIR', 'PLUGIN_VERSION', 'KEY_FILE', 'MODEL_FILE', 'BASE_URL_FILE',
  'SKILLS_DIR', 'SKILLS_CORE_DIR', 'SKILLS_MODES_DIR', 'SKILLS_PERSONAS_DIR', 'SKILLS_LORE_DIR',
  'PROVIDERS', 'SENSITIVE_KEYWORDS_RE', 'CONVERSATIONS_DIR', 'USER_PROFILE_DIR',
  'REQUEST_TIMEOUT',
]
const missingC = required.filter(k => c[k] === undefined)
if (missingC.length) {
  for (const k of missingC) check(`缺失常量: ${k}`, false)
} else {
  check(`${required.length} 个常量全部存在`, true)
}

// ===== 4. 工具函数 =====
console.log('\n\x1b[1m=== 工具函数 ===\x1b[0m')
const u = loaded.utils
const utilsExpected = [
  'splitSentences', 'sanitizeUserName', 'getRandomDelayMs',
  'sanitizeUserInput', 'isJailbreakAttempt', 'isHostileInput',
  'getSenderUserId', 'hasAdminPermission', 'stripMentions',
  'isDirectAtBot', 'formatPercent', 'readTextFile', 'writeTextFile',
  'sleep', 'extractImageUrls', 'isReplyTooSimilar', 'isOverusedReply',
  'getModelDisplayName', 'sanitizeReply',
]
const uMissing = utilsExpected.filter(k => typeof u[k] !== 'function')
if (uMissing.length) {
  for (const k of uMissing) check(`utils 缺失: ${k}`, false)
} else {
  check(`utils: ${Object.keys(u).filter(k => typeof u[k] === 'function').length} 个函数`, true)
}

// ===== 5. Persona 函数 =====
console.log('\n\x1b[1m=== Persona 函数 ===\x1b[0m')
const p = loaded.persona
const pExpected = [
  'getUserPersona', 'setUserPersona', 'resetUserPersona',
  'getGroupPersona', 'setGroupPersona', 'resetGroupPersona',
  'resolvePersona', 'getAvailablePersonals', 'loadPersonalSkill',
]
const pMissing = pExpected.filter(k => typeof p[k] !== 'function')
if (pMissing.length) {
  for (const k of pMissing) check(`persona 缺失: ${k}`, false)
} else {
  check(`persona: ${Object.keys(p).filter(k => typeof p[k] === 'function').length} 个函数`, true)
}

// ===== 6. API 函数 =====
console.log('\n\x1b[1m=== API 函数 ===\x1b[0m')
const api = loaded.api
const apiExpected = [
  'requestChatCompletions', 'buildFallbackConfig', 'isVisionModel',
  'readImageAsBase64', 'downloadImageAsBase64', 'callGetImage',
]
const aMissing = apiExpected.filter(k => typeof api[k] !== 'function')
if (aMissing.length) {
  for (const k of aMissing) check(`api 缺失: ${k}`, false)
} else {
  check(`api: ${Object.keys(api).filter(k => typeof api[k] === 'function').length} 个函数`, true)
}

// ===== 7. Conversation 函数 =====
console.log('\n\x1b[1m=== Conversation 函数 ===\x1b[0m')
const conv = loaded.conversation
const convExpected = [
  'getConversationHistory', 'readConversationDisk', 'writeConversationDisk',
  'saveConversationTurn', 'generateConversationSummary',
  'saveSharedChannelTurn', 'saveUserProfile', 'saveSensitiveCache',
  'analyzeChannelSensitive',
]
const convMissing = convExpected.filter(k => typeof conv[k] !== 'function')
if (convMissing.length) {
  for (const k of convMissing) check(`conversation 缺失: ${k}`, false)
} else {
  check(`conversation: ${Object.keys(conv).filter(k => typeof conv[k] === 'function').length} 个函数`, true)
}

// ===== 总结 =====
console.log('\n\x1b[1m=== 总结 ===\x1b[0m')
console.log(`  通过: ${totalPassed}  失败: ${totalFailed}`)
process.exit(totalFailed > 0 ? 1 : 0)
```

---

## 九、修改后必查清单

每次修改代码后检查以下清单：

- [ ] `node -c packages/koishi-plugin-dongxuelian-ai/lib/index.js` 语法检查通过
- [ ] `node -c packages/koishi-plugin-dongxuelian-help/lib/index.js` 语法检查通过
- [ ] 级联测试全部通过（模块加载 + 去重 + 常量）
- [ ] 没有引入新的 `require` 循环依赖
- [ ] 没有在 `index.js` 中定义已经在拆分文件中存在的函数
- [ ] 所有新函数符合命名规范（camelCase）
- [ ] DEBUG 日志没有泄露 API key
- [ ] 本地 bot 启动不报 `ReferenceError`
- [ ] 服务端上传后文件大小和本地一致（`ls -la` 对比）
- [ ] 服务端重启后看到 `loaded` 日志，且无 `ReferenceError`
