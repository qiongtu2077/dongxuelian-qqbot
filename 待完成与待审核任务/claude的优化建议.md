# 《claude的优化建议》长期扫描记录

扫描开始日期：2026-05-24

本文件按《优化建议》同一套要求单独记录 Claude 扫描结果。只记录本轮确认真实存在、仍需要处理的 bug 或风险；无法用代码路径、最小复现、测试或日志确认的疑点不写成 bug。

## 扫描要求

- 每轮扫描写明范围、证据、影响、建议修复和验证方式；如果没有新真实 bug，也记录排除的疑点。
- 扫描范围包括代码安全、架构、群聊接话、用户体验、上下文感知、图片/历史图片感知、文件读取、语音、搜索/fetch、人格文件、人格串台和 OOC 风险。
- 交互类问题不能只因“模型调用了工具 / 旧材料出现在 prompt / 跨用户接上了话”就判 bug；必须先定义当前场景在产品语义上应该自动执行、自然澄清、低权重参考还是忽略。
- 对 bot 交互类问题，至少同时考虑正例、反例和边界例；只有在用户认可的语义下仍出现错误行为，才能写入待修 bug。
- 涉及 AI 调工具、搜索/fetch、读图、读文件、Agent 行动等能力时，优先让模型基于上下文和工具说明自由判断；硬编码只用于权限边界、安全兜底、异常降级和少数可验证的确定性入口。
- 本文件是待审核记录；本轮不修代码、不部署、不重启、不推送。

## 本地第 8 轮（行动工具与发送边界专项）

范围：继续按长期要求做本地只读扫描，重点覆盖会写状态、会未来发消息、会向 QQ 发送文件、会启动浏览器访问外部页面、以及剩余直接 `session.send()` 的执行级边界。已复核上下文裁决类问题时不再把“跨用户承接公共任务”“私聊裸 URL fetch”“旧图旧文件低权重进入材料”单独判为 bug。

结论：本轮新确认 3 个本地真实问题或风险。其中 `send_file_to_user` 属于 QQ 默认暴露的行动类工具边界缺口；`browser_action` 属于启用并确认危险工具后仍缺少二跳/子资源内网访问防护的浏览器边界风险；`AI抓事件` 属于低优先级调试命令回执发送失败冒泡。

### C8-1 `send_file_to_user` 在 QQ 默认启用且非危险工具，可绕过 QQ 读文件关闭把允许根内文件发到群/私聊

真实性：真实存在，可本地最小复现。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/config.js` 的 QQ 默认工具配置中，`read_file`、`list_files`、`find_files` 均为 `false`，但 `send_file_to_user: true`。
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/send-file-to-user.js` 中：
  - `execute()` 接受任意 `params.path`，只要求 `assertExistingAgentPathInsideRoots(filePath, '文件')` 通过。
  - 默认允许根来自 `agent/path-guard.js`，包含 `process.cwd()`、仓库包目录、`DATA_DIR`、`SKILLS_DIR` 等。
  - 通过 `upload_group_file` / `upload_private_file` 把文件发送到当前群或私聊。
  - 工具元数据为 `dangerous: false`、`defaultChannels: ['qq']`。
- 这意味着 QQ 侧虽然默认禁用了读文件文本工具，但模型一次 `send_file_to_user({ path })` 调用仍可把允许根内的本地文件作为 QQ 文件发出去。

影响：
- 允许根内可能包含运行配置、数据文件、调试日志、人格/技能材料、历史缓存等；即使不是全盘任意读，也属于可见的数据外发动作。
- 该工具会直接向群/私聊发送文件，比普通 `read_file` 返回文本更不可逆、更打扰，也更像行动类工具；不应在 QQ 默认开启且标记为非危险。
- 如果模型误调用或被提示诱导，可能在没有确认的情况下把服务端本地文件发到当前聊天。

建议修复：
- 将 `send_file_to_user` 标记为 `dangerous: true`，并默认关闭 QQ 渠道，或至少要求执行级确认/显式授权后才能上传。
- 限制可发送文件来源：优先只允许当前会话上传文件的派生物、Agent 本轮生成的临时产物、或专门的 export 目录；不要复用通用读文件根。
- 对安全配置、key、日志、数据库、历史缓存等敏感后缀/目录加发送黑名单；写入阻止列表目前只覆盖写文件，不覆盖发送文件。
- 补 scenario：QQ 默认配置下 `send_file_to_user` 不应暴露或执行；经确认/授权的当前会话生成文件可以发送。

验证方式：
- 修复前：QQ Agent 工具列表包含 `send_file_to_user`；mock tool call 指向允许根内普通文件时会调用 `upload_group_file` / `upload_private_file`。
- 修复后：QQ 默认工具列表不包含该工具，或未确认时执行返回拒绝且不调用 OneBot 上传；授权后的安全产物发送仍可用。
- 回归：Dashboard 读写工具配置、Agent 工具白名单、危险工具确认策略测试仍通过。

### C8-2 `browser_action` 只校验首跳 URL，未拦截重定向和页面子请求访问内网

真实性：真实存在，可本地最小复现；该工具已标记 `dangerous: true` 且默认只在 dashboard 开启，因此记录为启用/确认后的边界风险，不是 QQ 默认暴露问题。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/browser-action.js` 的 `validateUrl(raw)` 会校验传入 URL 的协议、用户名密码、hostname 和 DNS 解析，拒绝 localhost / 内网 / 保留地址。
- `openUrl(url)` 只在 `p.goto(targetUrl)` 前调用一次 `validateUrl(url)`；导航完成后直接把 `currentUrl = p.url()`，没有校验最终 URL 是否因 30x / meta refresh / JS 跳转进入内网。
- `enableBrowserRequestGuards()` 的 request interception 只拦截图片、媒体、字体和广告域名；没有对每个请求的 URL / DNS / IP 做内网校验。
- `page.on('requestfinished')` 中发现 `remoteAddress().ip` 命中 `PRIVATE_IP_RE` 后才 `page.goto('about:blank')`，这是响应完成后的事后处理，不能阻止请求已经打到内网服务。
- `delete window.fetch/XMLHttpRequest/WebSocket/EventSource/sendBeacon` 只对当前文档执行一次，页面后续导航、iframe、新执行上下文或页面脚本仍可能绕过。

影响：
- 攻击者可给一个公网 URL，让它重定向到 `127.0.0.1`、云元数据地址或内网服务；首跳校验通过后，浏览器仍可能访问内网。
- 公网页面也可以通过 iframe、表单、脚本资源、CSS/HTML 引用等方式触发对内网的子请求；即使后续 blank 页面，请求已经发生，网络日志和页面文本/HTML/截图可能暴露内部响应片段或服务存在性。
- 因为浏览器工具具备 `text/html/screenshot/pdf` 等读取动作，SSRF 不只是连通性探测，还可能变成内容读取。

建议修复：
- 在 request interception 里对每个 `req.url()` 做同等 URL/hostname/IP 校验；无法校验或解析到内网时 `abort()`。
- 对 `framenavigated` / `response` / `request` 的最终 URL 做校验；发现跳到内网时立即 abort/close page，而不是等 `requestfinished`。
- 对 30x redirect chain 做显式校验，或使用 Chromium 请求拦截在跳转请求发出前阻断。
- 对 JS 网络能力使用 `evaluateOnNewDocument()` 注入，并覆盖未来文档；但它只能作为辅助，主防线仍应是请求级拦截。
- 补测试：公网 URL 302 到 localhost、页面 iframe localhost、页面 fetch localhost，均应被阻断；普通公网页面仍可打开和读取文本。

验证方式：
- 修复前：构造本地公网模拟页或测试 HTTP server，让 `/redirect` 302 到 `http://127.0.0.1:<port>/secret`；`browser_action navigate` 首跳通过，浏览器会尝试访问内网。
- 修复后：同样场景请求在发出前被 abort，`currentUrl` 不落到内网地址，`text/html/screenshot` 不返回内部内容。
- 回归：普通公网导航、搜索结果抽取、截图/PDF 文件大小限制和危险工具确认流程仍通过。

### C8-3 `AI抓事件` 抓取回执直接发送，平台拒发时会让 middleware reject

真实性：真实存在，可本地最小复现；该项是管理员/调试命令，优先级低于用户常用链路，但仍是确认的发送边界缺口。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/index.js` 的 armed event dump 分支在 `dumpSessionEvent()` 成功后直接执行 `await session.send(`已抓到原始事件：${dumpPath}`)`。
- 同一分支的 `catch` 中也直接执行 `await session.send('原始事件抓取失败。')`。
- 两处发送都没有 `.catch()` 或安全发送 helper；如果成功回执发送被平台拒绝，会进入 `catch`，随后失败回执再次拒发时异常冒泡出 middleware。
- 这不同于维护模式发送的 `await session.send(mt).catch(() => {})`，也不同于主回复链路的 safe send。

影响：
- 管理员执行 `AI抓事件` 后，下一条消息如果触发平台风控/禁言/拒发，调试抓取链路会制造 middleware reject。
- 成功写入 dump 文件但回执失败时，用户侧可能看到“没反应”，日志却同时有抓取成功和发送失败；排查原始事件时容易误判为抓取失败。
- 虽然该命令面向管理员，仍应和其他调试/控制命令一样做到发送失败受控。

建议修复：
- 给 event dump 回执使用轻量 `safeSendCommandMessage()` 或本地 `.catch()`，发送失败只记录 warn，不让 middleware reject。
- 成功写入 dump 与回执发送失败要分开记录：文件写入成功就不应再把整体状态说成“抓取失败”。
- 补 scenario：mock `dumpSessionEvent()` 成功但 `session.send()` 抛 `retcode: 1200`，断言 middleware 不 reject、arm state 已清理、日志有受控 warn。

验证方式：
- 修复前：armed event dump + `session.send()` 拒发会 reject；成功回执失败后失败回执也可能 reject。
- 修复后：同样输入下 middleware resolve，dump 文件已写入，arm state 清理，发送失败仅记录受控 warn。
- 回归：`AI抓事件` 正常成功路径仍能写入事件 JSON 并在可发送时提示路径。

## 本地第 8 轮排除/暂不新增

- `create_reminder` 已在原《优化建议》记录为 L7-1，本文件不重复扩写。
- 普通上下文裁决：跨用户公共任务接力、私聊裸 URL 读取、旧图旧文件作为低权重材料都不能单独判 bug；本轮未复现出违反正例/反例/边界例语义的新增交互问题。
- `read_file` / `list_files` / `find_files` / `grep_search` 的路径校验仍走 `agent/path-guard.js` 允许根；本轮未确认新的路径穿越。
- `web_fetch` / `web_search` 仍有 URL 校验、重定向限制、大小/超时限制；本轮未确认新的 fetch/search 边界 bug。
- `daily-report`、`local-video-sender`、`group-name-at` 已有 safe send helper；`defense`、人格命令、`今日情绪` 已在原《优化建议》记录，本文件不重复记录。

## 本地第 9 轮（真实交互体验模拟专项）

范围：按用户补充要求，把 bot 交互体验 bug 也纳入扫描。使用现有 scenario harness 和定向 mock 模拟用户消息，覆盖命令/控制面、搜索和链接、图片/历史图片、文件、语音、贴纸、复读、随机回复等常用功能。本轮只读模拟，不改代码。

结论：现有全量 scenario 在模拟环境中通过（859 passed / 0 failed / 1 skipped），但新增真实用户输入组合确认 8 个交互体验问题。其中 C9-1、C9-5、C9-6 会直接影响搜索/图片/历史图片主体验；C9-2 到 C9-4 属于命令控制面反馈不一致；C9-7 属于复读体验不一致。

### C9-1 “帮我搜一下/搜一下”这类动作短句被当作自包含搜索 query，绕过热/冷上下文裁决

真实性：真实存在，可本地模拟复现；不同于原《优化建议》里的 L2-1 heavy `web_search` 绕过，这里是直接 Agent heuristic / search builder 路径误判。

正例、反例和边界例：
- 正例：私聊用户刚在热窗口内说“鸣潮最新角色是谁”，马上说“帮我搜一下”，应承接热对象，query 应围绕“鸣潮最新角色是谁”。
- 反例：私聊用户 4 小时前说过“鸣潮最新角色是谁”，现在只说“帮我搜一下”，不应复活冷旧对象，应自然澄清或走普通 chat。
- 边界例：群聊 B 接 A 的公开任务不能一刀切禁止；如果 B 明确引用、明确加入或现场任务明显公共，可以执行；但 B 只说“搜一下”且无引用/锚点时，应澄清搜索对象。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/search-context.js` 已有 `looksLikeActionOnlyFollowUp()` 和 `buildPrivateSearchContext()`，能把动作短句分成 `can_complete_from_hot`、`blocked_by_cold` 或 `needs_chat_handling`。
- 但 `packages/koishi-plugin-dongxuelian-ai/lib/agent/router.js` 的 `EXPLICIT_SEARCH_RE` 包含裸 `搜一下` / `搜索一下` / `帮我查` / `查一下`，`isGeneralSearchIntent()` 会直接把这类短句视为 general search。
- `heuristicRoute()` 在 `EXPLICIT_AGENT_RE` / general search 分支会进入 Agent；`buildExplicitSearchRunOptions()` 又因 `isSelfContainedSearchIntent()` 为真跳过结构化 blocked gate。
- 本地模拟结果：
  - 私聊热 follow-up `帮我搜一下` 执行 `web_search`，query 变成 `帮我`，没有使用热对象“鸣潮最新角色是谁”。
  - 私聊冷 follow-up `帮我搜一下` 也执行 `web_search`，query 同样是 `帮我`，没有澄清。
  - 群聊 A 说 `原神最新兑换码`，B @bot 说 `搜一下`，执行 `web_search`，query 为 `搜一下`。

影响：
- 用户以为 bot 会承接刚才对象，实际搜了“帮我/搜一下”这种无意义 query，最终容易返回空结果或编造式兜底。
- 冷旧话题会被动作短句绕过 gate 重新拉进搜索，继续造成“旧任务复活/错接”的体验。
- 群聊里短句搜索对象不明时直接执行，会让用户觉得 bot 自作主张或搜错对象。

建议修复：
- `EXPLICIT_SEARCH_RE` / `isGeneralSearchIntent()` 不应把裸动作短句当自包含搜索；动作短句统一交给 `searchContext.searchReadiness` 裁决。
- `buildContextualSearchQuery()` 在 `can_complete_from_hot/warm` 时应优先用 `queryCandidate`，即使当前短句命中了搜索动词。
- 对 `blocked_by_cold` / `needs_chat_handling`，即使命中“搜一下”，也不要预执行搜索；让 chat 自然澄清。
- 补 scenario：热对象 + “帮我搜一下” query 使用热对象；冷对象 + “帮我搜一下” 不执行 web_search；群聊无锚点 `搜一下` 先澄清。

验证方式：
- 修复前：上述三组模拟会执行 `web_search`，query 为 `帮我` 或 `搜一下`。
- 修复后：热 follow-up 搜索热对象；冷/无锚点短句不调用 Agent 搜索，回复为自然澄清。
- 回归：自包含搜索如“帮我查一下今天上海天气怎么样”仍能走 Agent。

### C9-2 群管理员无法设置群聊 AI 主动回复概率，和命令自身权限说明冲突

真实性：真实存在，可本地模拟复现。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/admin-commands.js` 中 `东雪莲群聊AI概率设置 <百分比>` 的权限判断允许 `isGroupAdmin || hasAdminPermission(session)`，失败文案也是“只有群主、群管理员或bot管理员才能设置概率”。
- 但 `packages/koishi-plugin-dongxuelian-ai/lib/index.js` 的 `adminCommandMatched` 把 `东雪莲群聊AI概率设置/重置` 先归为管理员命令；随后在调用 `handleAdminInlineCommands()` 前先执行 `if (adminCommandMatched && !hasAdminPermission(session)) return '只有指定管理员能操作这个命令。'`。
- 本地模拟：群管理员发送 `东雪莲群聊AI概率设置 42%`，实际回复 `只有指定管理员能操作这个命令。`，`ai-random-rate.json` 不变。

影响：
- 群管理员看起来有权限管理本群主动回复概率，但实际被 bot 管理员前置门槛拦住。
- 同类语音概率命令允许群管理员设置当前群，造成两个概率控制面的权限体验不一致。
- 群主/管理员无法自助调低或调高本群主动回复，容易把普通运维需求推给 bot 管理员。

建议修复：
- 不要在 `adminCommandMatched` 前置门槛里拦截 `东雪莲群聊AI概率设置/重置`，让它进入 `handleAdminInlineCommands()` 使用自身的群管理员权限判断。
- 或把前置判断细化为“bot-only 命令”和“群管理员可用命令”两类。
- 补 scenario：群管理员可设置本群 AI 概率；普通成员被拒；bot 管理员仍可设置。

验证方式：
- 修复前：群管理员设置 42% 被“指定管理员”拒绝。
- 修复后：群管理员设置成功并写入 `ai-random-rate.json`；普通成员仍拒绝。

### C9-3 概率设置输入超过范围时没有清晰错误反馈

真实性：真实存在，可本地模拟复现。

证据：
- `admin-commands.js` 的 AI 概率正则只匹配 `0-100%`，`120%` 不匹配；虽然后面有 `rate < 0 || rate > 1` 的范围提示，但对 `120%` 永远到不了。
- 语音概率设置同样只匹配 `0-100%`，`东雪莲群聊语音概率设置 120%` 不匹配，范围提示也到不了。
- 本地模拟：bot 管理员发送 `东雪莲群聊AI概率设置 120%` 和 `东雪莲群聊语音概率设置 120%`，状态不变，但没有明确“范围只能 0% 到 100%”回复。

影响：
- 用户输入超范围数字时只感觉“没反应”，不知道是格式错、权限错还是命令没被识别。
- 控制面命令越常用于排障，越需要明确失败原因；静默失败会增加重复尝试和误配置。

建议修复：
- 先用宽松正则识别“概率设置 + 数字%”，再在代码里做范围校验并返回清晰错误。
- AI 概率和语音概率用同一套百分比解析 helper，避免一个命令有提示、另一个命令静默。
- 补 scenario：`120%`、`-1%`、`abc%` 分别有可理解反馈；合法 `0%/100%/42.5%` 仍成功。

验证方式：
- 修复前：`120%` 无明确回复。
- 修复后：回复“概率范围只能是 0% 到 100% 之间”或同义提示，状态不写入。

### C9-4 `东雪莲群人格切换` 缺少名称时静默消耗消息

真实性：真实存在，可本地模拟复现。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/handler.js` 只处理 `plain.startsWith('东雪莲群人格切换') && plain !== '东雪莲群人格切换'`，没有 exact-match 帮助分支。
- 个人命令 `东雪莲人格切换` 有明确提示：`请写要切换的人格名：东雪莲人格切换 <名称>`。
- 本地模拟：群主发送 `东雪莲群人格切换`，实际没有回复，`nextCalled=false`。

影响：
- 群主/管理员按自然命令探索时会得到“没反应”，不知道需要补人格名称。
- 个人命令有帮助，群命令没有，控制面体验不一致。

建议修复：
- 增加 exact-match 分支，回复 `请写要切换的群人格名：东雪莲群人格切换 <名称>`，并可附带 `东雪莲人格列表` 提示。
- 补 scenario：群管理员缺少名称时收到用法提示；普通成员仍按权限提示拒绝；合法名称仍切换成功。

验证方式：
- 修复前：`东雪莲群人格切换` 无回复。
- 修复后：返回明确用法提示，不改群人格状态。

### C9-5 未知模型名的 `切换xxx` 命令没有“未找到模型”反馈

真实性：真实存在，可本地模拟复现。

证据：
- `handler.js` 中 `const switchMatch = plain.match(/^切换(.+)$/)` 命中后，管理员权限通过时会遍历 `PROVIDERS` 查找模型。
- 只有找到 `foundProvider` 时才返回 `已切换至...`；找不到时没有返回“未找到模型”，继续向后落入其它流程。
- 本地模拟：bot 管理员发送 `切换不存在模型`，没有有用反馈。

影响：
- 管理员输错模型名时不知道是模型不存在、命令格式错误还是 bot 没处理。
- 模型切换是高风险控制面，失败反馈不清晰会导致重复尝试或误以为已切换。

建议修复：
- `switchMatch` 命中且权限通过但未找到模型时，直接返回 `未找到模型：xxx`，并提示使用 `AI状态` 或模型列表命令查看可用项。
- 补 scenario：未知模型不写 provider/model 文件，返回未找到提示；非管理员仍返回权限拒绝；合法模型仍切换。

验证方式：
- 修复前：未知模型无明确回复。
- 修复后：返回未找到提示，配置文件不变。

### C9-6 当前图片直读不复用已缓存图片，可能明明有缓存却回复“图片无法访问”

真实性：真实存在，可本地模拟复现。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/vision.js` 的 `appendVisionMessage()` 对当前图片只尝试：
  - `payload.file` -> `callGetImage(payload.file)` -> 本地路径；
  - `payload.urls[0]` -> `downloadImageAsBase64()`。
- 它没有像 `packages/koishi-plugin-dongxuelian-ai/lib/image-analyzer.js` 那样先尝试 `readCachedImage()`。
- 本地模拟：预先 `image-store.cacheImageFile('10001', 'cur-img', png)`，再发送 `<at id="90000"/> 这图是啥 [CQ:image,file=cur.png]`；当前识图仍返回 `<quote id="cur-img"/>图片无法访问，换个图试试？`，没有进入正常视觉回复。

影响：
- NapCat `get_image` 或 URL 临时不可用时，即使本地后台已经缓存过同一图片，当前图片直读仍失败。
- 用户会觉得 bot “刚才明明存过图却说看不到”，尤其影响“这图是啥/评价这张图”这种核心体验。
- 历史图片分析和当前图片分析使用两套读取策略，表现不一致。

建议修复：
- `appendVisionMessage()` 在 `callGetImage()` / URL 下载失败时，按 channel/messageId 或 file 标识尝试读取 image-store 缓存。
- 当前消息存储图片时要确保 messageId、file、url 和缓存路径之间有可回查关系。
- 补 scenario：缓存存在但 `get_image` 失败时，当前图片仍能进入视觉模型；缓存不存在时才返回无法访问。

验证方式：
- 修复前：缓存存在但当前图片识别仍报无法访问。
- 修复后：同样输入能把缓存图片 base64 注入多模态消息；没有缓存时仍保持原失败提示。

### C9-7 历史图片需要 `read_image_history -> analyze_historical_image` 两步时，第二轮工具调用会被丢弃

真实性：真实存在，可本地模拟复现。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/chat.js` 在处理轻量 tool calls 时，执行 `handleChatToolCalls()` 后会把 tool 结果追加进 messages，再次 `callOpenAI()`。
- 但第二次模型如果继续返回 `tool_calls`，代码直接 `reply = reply.message?.content || ''`，不会再执行第二轮工具。
- 本地模拟：用户问“刚才那张图是什么”；模型第一轮正确调用 `read_image_history` 找候选，第二轮继续调用 `analyze_historical_image` 分析候选；实际只执行第一步，第二步被丢弃。

影响：
- 按工具设计，历史图片常需要“先读历史候选，再分析具体图片”两步；当前 chat 只支持一轮轻量工具，会让模型正确规划也无法完成。
- 用户会收到空回复、猜测回复或“没看到图”类兜底，体验像历史图片功能不稳定。
- 类似多步轻量工具链（先列文件/图片，再分析）也可能受影响。

建议修复：
- 对轻量工具调用支持有限轮数循环，例如最多 2-3 轮；每轮执行后继续交给模型，直到得到文本或触发 heavy tool。
- 设置循环上限和重复 tool_call 去重，避免模型无限调用。
- 补 scenario：`read_image_history -> analyze_historical_image -> 文本回答` 能完整执行；循环超过上限时给受控提示。

验证方式：
- 修复前：第二轮 `analyze_historical_image` 不执行。
- 修复后：两步工具都执行，最终回复基于图片分析结果。

### C9-8 结构化 `mface` / 大表情无法复读，和 QQ 原生 face 复读体验不一致

真实性：真实存在，可本地模拟复现。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/repeat.js` 的 `buildRepeatCandidate()` 会先提取结构化 `face` 和 CQ `face`，能复读 `[CQ:face,id=76]`。
- 但 `mface` 被 `analyzed.hasVisual` 归到 unsupported visual，直接返回 `buildUnsupportedRepeatCandidate('visual')`。
- 本地模拟：开启复读后，两名用户连续发送相同 `{ type: 'mface', data: { emoji_id: '123', url: '...' } }`，第二条不复读；同场景 QQ 原生 face 会回复 `<face id="76"/>`。

影响：
- QQ 用户常用大表情/贴纸触发复读预期，但 bot 只复读原生小黄脸，行为割裂。
- 群聊里连续大表情是最常见的复读场景之一，不支持会让复读功能显得“不灵”。

建议修复：
- 增加 `mface` repeat candidate：用 `emoji_id` / `emoji_package_id` / `key` 形成稳定 key，回复原始 mface 或可发送的等价消息段。
- 如果平台无法可靠重发 mface，也应明确按“不支持 mface 复读”记录并在测试中锁住；不要混在普通视觉 unsupported 里。
- 补 scenario：相同 mface 连续出现能复读或明确跳过；不同 mface 不误复读；原生 face 回归不变。

验证方式：
- 修复前：相同 mface 不复读。
- 修复后：相同 mface 能复读，或至少有明确设计上的跳过测试；原生 face 仍可复读。

## 本地第 9 轮排除/暂不新增

- 私聊裸 URL：本轮模拟中裸 `https://...` 没有自动 fetch，只走普通 chat；但用户已说明私聊裸 URL 自动读取也可以是合理产品语义，因此不把“是否自动 fetch”单独记为 bug。
- 群聊裸 URL：无 @ 的群聊裸 URL 没有触发回复或工具调用；本轮不新增。
- 群聊明确链接总结：`帮我看看这个链接 https://... 写了什么` 能预执行 `web_fetch` 并基于 mock 正文转述；本轮不新增。
- 文件上传/历史锚点/读文件守卫：模拟中基本可用，真实文件内容会被 guard 注入二次回答；本轮未确认新 bug。
- 普通随机主动回复、QQ face 复读、贴纸发送/冷却/失败 fallback、bot 贴纸锚点已有场景覆盖通过；本轮不新增。
- 普通群语音会写入 `[语音]` 公共锚点，不会乱 ASR 或主动回复；本轮不新增。

## 本地第 10 轮（收敛复扫：计划与定时任务）

范围：在 C8/C9 已记录问题基础上继续收敛，只读复扫记忆、计划、提醒/定时任务、文件变体、Dashboard-vs-QQ 工具暴露、persona/OOC、随机回复和命令 fallthrough。重点排除已记录项后，寻找仍未记录的状态写入、未来消息、跨会话泄露和权限边界问题。

结论：本轮新确认 3 个问题。C10-1 是普通 chat 轻量工具中比 `create_reminder` 更宽的定时任务误创建风险；C10-2 是 QQ Agent 计划工具默认非危险导致持久计划状态和完成推送可被工具误调用；C10-3 是计划查看命令跨用户/跨群泄露计划内容。

### C10-1 `create_scheduled_task` 默认 QQ 暴露且非危险，缺少执行级显式意图门禁

真实性：真实存在，可本地最小复现；该问题和原《优化建议》的 `create_reminder` 意图 gate 类似，但范围更宽，包含周期任务和未来 Agent 执行。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/chat-tools.js` 把 `create_scheduled_task`、`list_scheduled_tasks`、`pause_scheduled_task`、`resume_scheduled_task`、`delete_scheduled_task`、`run_scheduled_task_now` 放进普通 chat 轻量工具集合；随机主动回复时才过滤。
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/config.js` 的 QQ 默认工具配置开启 `create_scheduled_task` 及相关管理工具。
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/scheduled-task-tools.js` 中 `createScheduledTaskTool` 为 `dangerous: false`、`defaultChannels: ['qq', 'dashboard']`。
- `executeCreateScheduledTask()` 只检查随机触发、目标频道、时间合法性、cron schedule 是否存在；没有检查当前用户原文是否明确要求“定时/每天/每周/到点/自动执行”。
- `mode='cron'` 会 `registerCron()`，`type='agent'` 会在未来由 cron 运行 Agent prompt；一次性 text/agent 也会写入 `agent-crons.json` 并注册 timer。

影响：
- 一次模型误调用就能在 QQ 中创建未来自动消息或未来 Agent 行动；周期任务还会长期重复触发。
- `type='agent'` 会在用户不在线时重新调用 Agent，再把结果推回目标频道，副作用大于普通提醒。
- 当前只靠工具描述约束“用户要求每天/每周/定时执行时调用”，执行层没有兜底。

建议修复：
- 给 `create_scheduled_task` 增加执行级 intent gate：当前消息必须明确包含定时、周期、每天、每周、几点、到点、自动执行等请求，或上游传入可信 `scheduledTaskIntent=true`。
- `mode='cron'`、`type='agent'` 建议默认需要确认，或至少 QQ 默认关闭，仅 Dashboard/显式计划模式可用。
- 管理类工具保留查询可见性，但 pause/resume/delete/run-now 也应确认当前用户确实请求管理定时任务。
- 补 scenario：普通闲聊 + 模型误调用 `create_scheduled_task` 不写 `agent-crons.json`；明确“每天 8 点提醒我/运行总结”才创建。

验证方式：
- 修复前：普通消息中 mock 工具调用 `create_scheduled_task({ mode:'cron', type:'agent', schedule:'0 8 * * *', prompt:'总结群聊' })` 会写入定时任务。
- 修复后：无明确意图不写文件、不注册 timer；明确周期任务仍创建。

### C10-2 计划工具默认 QQ 暴露且非危险，可写持久计划状态并触发完成推送

真实性：真实存在；记录为 QQ Agent/计划工具执行级风险。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/config.js` 的 QQ 默认工具配置开启 `create_plan`、`update_task_status`、`check_plan_status`、`finish_plan`、`abandon_plan`。
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/plan/plan-tools.js` 中这些计划工具均为 `dangerous: false`、`defaultChannels: ['dashboard', 'qq']`。
- `create_plan` 会调用 `plan-engine.createPlan()`，落盘到 `DATA_DIR/agent-plans/*.json` 并更新 `active.json`。
- `update_task_status`、`finish_plan`、`abandon_plan` 会修改计划状态；`finish_plan` 在 `context.bot && plan.channelKey` 时异步调用 `push.taskComplete()`，会向计划频道推送完成消息。

影响：
- 计划工具不是纯内部推理：它会写持久状态，`finish_plan` 还会产生平台发送副作用。
- 如果 QQ Agent 在普通任务中误调用计划工具，可能创建用户未要求的计划、篡改已有计划状态，甚至推送“计划完成”。
- 这会让用户看到凭空出现的计划状态和完成通知，属于交互体验和权限边界双重问题。

建议修复：
- `create_plan/update_task_status/finish_plan/abandon_plan` 至少加执行级 intent gate 或标记危险；普通 QQ Agent 默认不应无确认写计划状态。
- 计划执行模式内部需要这些工具时，可通过专门上下文标记 `planExecution=true` 放行，而不是全局默认任意 Agent 可写。
- `finish_plan` 的平台推送应要求计划确为用户显式创建，且当前上下文允许主动推送；否则只返回工具结果。
- 补 scenario：普通 QQ Agent 误调用 `create_plan` 不落盘；`/plan` 或 `莲莲计划` 显式路径仍能创建并执行计划。

验证方式：
- 修复前：QQ Agent 工具列表默认包含计划写工具，执行后写 `agent-plans` 或触发完成推送。
- 修复后：普通 QQ Agent 无确认/无计划上下文时拒绝写计划；显式计划模式回归正常。

### C10-3 `计划查看` 默认读取全局 active/recent 计划，跨用户/跨群泄露计划内容

真实性：真实存在，可本地模拟复现。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/commands/plan-command.js` 的 `计划查看` / `/plans` 分支直接执行 `planEngine.checkPlanStatus(planStatusMatch[1] || '')` 并格式化返回。
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/plan/plan-engine.js` 的 `checkPlanStatus('')` 返回 `store.listActivePlans()` 和 `store.listPlans(20)`。
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/plan/plan-store.js` 的 `active.json` 是全局索引，`listActivePlans()` / `listPlans()` 不按 `channelKey` 或 `userId` 过滤。
- 同一命令文件中 `计划继续` 使用 `planRunner.resolvePlan(..., { userId, channelKey })`，`计划放弃` 会校验 `plan.userId !== currentUserId && !hasAdminPermission(session)`；说明查看路径缺少同等 owner/channel 校验。
- 本地模拟：用户 A / 群 A 创建标题为“用户A私有计划”的计划后，用户 B / 群 B 发送 `计划查看`，收到 A 的计划标题和任务内容；B 知道 planId 时发送 `计划查看 plan_...` 也可查看。

影响：
- 计划标题、步骤、任务结果可能包含用户目标、文件名、查询内容、群聊上下文或隐私材料。
- 任意群/用户用 `计划查看` 就能看到全局执行中计划，跨群串台严重。
- 因为 `计划放弃` 有权限挡住，用户会误以为计划系统已按 owner 隔离，实际查看泄露。

建议修复：
- `计划查看` 默认只列当前用户/当前会话可见计划；带 planId 时要求 `plan.userId === currentUserId`、同群共享策略明确成立，或 bot 管理员。
- `plan-engine.checkPlanStatus()` 可增加可见性参数，避免命令层和工具层重复漏校验。
- QQ plan tools 的 `check_plan_status` 也应带同样 owner/channel 过滤，不能返回全局 active/recent。
- 补 scenario：B 群不能看到 A 群计划；同一用户/同一群策略按产品定义可见；bot 管理员可查看。

验证方式：
- 修复前：B 群 `计划查看` 能看到 A 群计划。
- 修复后：B 群返回“当前没有可查看计划”或只显示 B 群/B 用户计划；管理员查看路径另测。

## 本地第 10 轮排除/暂不新增

- 记忆命令默认管理员门槛存在，`莲莲记住/回忆/列表/忘记` 本轮未发现跨用户泄露。
- 提醒/定时任务的查看、取消、暂停、删除、立即运行路径已有 `targetChannel + createdBy/targetUserId` 可见性过滤；除 C10-1 的创建意图门禁外，本轮未确认跨群管理泄露。
- `create_uploaded_file_variant` 只取当前会话近期上传文件，不读任意本地路径；本轮未新增。
- Dashboard 工具面更宽符合管理端语义；QQ 的 shell/write/browser 默认仍受开关或危险策略限制，除已记录项外本轮未新增。
- persona/OOC、随机回复、命令 fallthrough：除 C9 已记录项外，本轮未确认新的高置信交互 bug。

## 本地第 11 轮（最终收敛扫描）

范围：最后做一轮只读收敛，排除本文件 C8-C10 和原《优化建议》L1-L7/S 系列已记录问题后，继续检查命令发送边界、QQ/Dashboard 工具暴露、计划/定时/记忆、媒体/文件/搜索、人格/OOC、平台发送路径。

结论：本轮未发现新的可确认 bug。

排除/暂不新增：
- 命令与发送边界：`index.js`、`handler.js`、`commands/emotion-command.js`、`reply.js`、`sensitive.js` 的新命中要么已由 L1/C8 记录，要么已有 catch/safe send；本轮不新增。
- 工具暴露：QQ 默认工具和 registry 元数据的新风险已归入 C8-1、C10-1、C10-2；本轮没有发现新的默认高危工具外放。
- 计划/定时/记忆：跨计划查看、计划写状态、定时任务创建意图门禁已记录为 C10；记忆工具默认管理员门槛仍在，本轮未确认跨用户泄露。
- 媒体/文件/搜索：当前图片缓存复用、多步历史图片、动作短句搜索、发送文件问题已记录；文件变体和文件分析未确认新的跨会话读写。
- 人格/OOC：除人格命令发送失败和群人格缺少参数提示等已记录项外，本轮未复现新的高置信串台或 OOC 外发问题。

## 当前收敛状态

截至第 11 轮，本文件新增并写入待审核的真实问题为：

- C8-1：`send_file_to_user` 在 QQ 默认启用且非危险，可把允许根内文件发到群/私聊。
- C8-2：`browser_action` 只校验首跳 URL，未拦截重定向和页面子请求访问内网。
- C8-3：`AI抓事件` 抓取回执直接发送，平台拒发时会让 middleware reject。
- C9-1：“帮我搜一下/搜一下”动作短句被当自包含搜索 query，绕过热/冷上下文裁决。
- C9-2：群管理员无法设置群聊 AI 主动回复概率，和命令自身权限说明冲突。
- C9-3：概率设置输入超过范围时没有清晰错误反馈。
- C9-4：`东雪莲群人格切换` 缺少名称时静默消耗消息。
- C9-5：未知模型名的 `切换xxx` 命令没有“未找到模型”反馈。
- C9-6：当前图片直读不复用已缓存图片，可能明明有缓存却回复“图片无法访问”。
- C9-7：历史图片两步工具链 `read_image_history -> analyze_historical_image` 中第二轮工具调用会被丢弃。
- C9-8：结构化 `mface` / 大表情无法复读，和 QQ 原生 face 复读体验不一致。
- C10-1：`create_scheduled_task` 默认 QQ 暴露且非危险，缺少执行级显式意图门禁。
- C10-2：计划工具默认 QQ 暴露且非危险，可写持久计划状态并触发完成推送。
- C10-3：`计划查看` 默认读取全局 active/recent 计划，跨用户/跨群泄露计划内容。

最终收敛扫描没有再确认新的 bug。后续若进入修复，建议优先级为：先处理会外发/未来发消息/跨会话泄露的 C8-1、C10-1、C10-2、C10-3；再处理直接影响主体验的 C9-1、C9-6、C9-7；最后统一收口命令反馈类 C9-2 到 C9-5 和复读体验 C9-8。

## 本地第 12 轮（本地 MCP 工作台专项）

范围：按用户补充要求使用本地 MCP 接口做只读/受控复核，覆盖 MCP JSON-RPC 初始化、工具列表、配置开关、工作区写入开关、本地检查命令白名单和路径边界。本轮只记录 MCP 接口确认的问题；不修代码、不部署、不重启、不推送。

结论：本轮新确认 2 个本地 MCP 工作台问题。C12-1 是 `run_local_check` 的 `node -c <file>` 允许越过工作区/允许根读取任意本地文件的语法错误片段；C12-2 是 Dashboard 启用 MCP 时默认同时放开工作区写入和本地检查，权限默认值过宽。

### C12-1 MCP `run_local_check` 的 `node -c <file>` 未限制允许根，可通过语法错误输出泄露任意本地文件片段

真实性：真实存在，可本地 MCP JSON-RPC 最小复现。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/mcp/local-server.js` 的 `parseLocalCheckCommand(command)` 只允许 `check`、`quick`、`scenario`、`test` 或 `node -c <file>`，其中 `node -c` 分支只过滤 `[;&|<>\`]` 等 shell 元字符。
- 同一分支把目标直接返回为 `['node', ['-c', target]]`，没有调用 `agent/path-guard.js`、没有限制 `target` 必须位于 `WORKSPACE_ROOT` 或 MCP 允许根内，也没有禁止绝对路径和 `..`。
- `run_local_check` 执行后会把 `stdout` / `stderr` 原样拼入 MCP 返回文本；`node -c` 对语法错误文件会输出错误行源码和 caret 定位。
- 本地用临时 `DONGXUELIAN_AI_DATA_DIR` 启用 MCP 后，构造允许根外的临时 JS 文件并写入标记字符串 `MCP_LEAK_MARKER_ABC123_NOT_A_REAL_SECRET`，通过 MCP 调用 `run_local_check({ command: 'node -c "<允许根外文件>"' })`，返回的 stderr 中包含该标记行，证明允许根外内容可经语法错误外泄。
- 同轮复核中，`node -c packages/...; echo pwn` 会被拒绝为 `node -c 目标文件不合法`，说明问题不是 shell 注入，而是路径/文件读取边界缺失。

影响：
- 只要 MCP 已启用且 `allowRunLocal` 为真，调用方可以对任意本地可读 JS 文件运行语法检查；文件若存在语法错误，错误输出会携带源码片段。
- 这绕过了 MCP `read_file` / Agent 文件工具的允许根设计：即使读文件工具受路径 guard 保护，`run_local_check` 仍能通过 Node 诊断输出侧信道读取允许根外内容。
- 服务端环境中风险更高：如果能指向配置、脚本、临时文件或日志副本，可能泄露路径、源码片段、环境布局或敏感字符串。

建议修复：
- `node -c <file>` 解析后必须 `path.resolve(WORKSPACE_ROOT, target)` 并校验在工作区或明确允许根内；拒绝允许根外绝对路径、跨盘路径和 `..` 逃逸。
- 对 `stderr` 做更严格裁剪/脱敏，或只返回 “语法检查通过/失败 + 文件相对路径 + 首条错误摘要”，不要回传源码行。
- 若需要检查允许根外文件，应通过单独管理员确认路径白名单，不复用普通 MCP 本地检查入口。
- 补 MCP 单测：允许根内 `node -c` 可执行；允许根外绝对路径和 `../` 路径拒绝；语法错误输出不包含源码标记字符串。

验证方式：
- 修复前：MCP `run_local_check` 指向允许根外语法错误 JS 文件，返回 stderr 中包含该文件源码行。
- 修复后：同样调用返回路径不允许，不执行 `node`；允许根内文件仍可检查但错误输出不泄露源码行。

### C12-2 Dashboard 启用 MCP 时默认同时允许工作区写入和本地检查，权限默认值过宽

真实性：真实存在，可由配置默认值和 Dashboard 行为确认。

证据：
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/config.js` 的默认 MCP 配置为 `enabled: false`、`allowWriteWorkspace: true`、`allowRunLocal: true`、`exposeDangerousActions: false`。
- `normalizeMcpConfig()` 在字段缺失时沿用默认值，因此旧配置或首次启用 MCP 时，`allowWriteWorkspace` 和 `allowRunLocal` 会默认变成 true。
- `packages/koishi-plugin-dashboard/frontend/src/components/AgentPanel.vue` 的默认前端配置同样是 `allowWriteWorkspace: true`、`allowRunLocal: true`。
- Dashboard 的 `toggleMcp()` 只切换 `config.mcp.enabled = !config.mcp.enabled` 并保存，没有在启用时把写入/运行能力保持关闭或二次确认。
- `applyConfig()` 使用 `allowWriteWorkspace: merged.mcp?.allowWriteWorkspace !== false` 和 `allowRunLocal: merged.mcp?.allowRunLocal !== false`，服务端未返回 false 时前端也显示为已允许。
- 本地 MCP 复现中，用最小配置启用 MCP 后 `get_bot_health` 显示 `mcp.enabled: true`、`allowWriteWorkspace: true`、`allowRunLocal: true`，随后 `write_file` 和 `run_local_check` 可用。

影响：
- 用户以为只是“启用 MCP 工作台”，实际同时打开了写工作区和运行本地检查两类高权限能力；这是权限升级式的默认值惊讶。
- `write_file` / `edit_file` 能修改工作区文件，`run_local_check` 能启动受控本地命令；结合 C12-1，默认放开 run 会放大路径侧信道风险。
- 对本地开发机和服务器都不应把写入/运行作为启用 MCP 的默认附带权限，尤其 Dashboard 按钮没有把风险表达成二次确认。

建议修复：
- 默认值改为 `allowWriteWorkspace: false`、`allowRunLocal: false`；启用 MCP 只开放只读诊断工具。
- Dashboard 启用 MCP 时保持写入/运行关闭，并在用户单独勾选时显示明确风险说明或确认。
- `write_file`、`edit_file`、`run_local_check` 的工具列表可继续展示，但执行层必须在对应开关关闭时拒绝。
- 补配置迁移/前端测试：新配置启用 MCP 后写入/运行仍为 false；显式勾选后才允许；旧配置中已明确 true 的安装保持可用或按迁移策略提示用户复核。

验证方式：
- 修复前：只设置 `mcp.enabled=true` 或在 Dashboard 点“启用 MCP”，`get_bot_health` 显示写入/运行均 true，`write_file` / `run_local_check` 可执行。
- 修复后：只启用 MCP 时写入/运行为 false，对应工具执行返回关闭提示；用户单独授权后才可用。

## 本地第 12 轮排除/暂不新增

- MCP JSON-RPC `initialize`、`tools/list`、`tools/call` 基本协议路径可用；未确认协议层异常导致的新增问题。
- `run_local_check` 的 shell 元字符注入本轮已用 `; echo pwn` 验证被拒绝，暂不记录为命令注入 bug。
- `write_file` / `edit_file` 仍复用 Agent 写文件工具自身路径限制；除 C12-2 的默认授权过宽外，本轮未确认新的写路径穿越。
- MCP `read_file` / `list_files` / `find_files` / `grep_search` 仍走对应 Agent 文件工具；本轮未确认新的允许根绕过。

## 当前收敛状态（含 MCP 专项）

截至第 12 轮，本文件新增并写入待审核的真实问题为：

- C8-1：`send_file_to_user` 在 QQ 默认启用且非危险，可把允许根内文件发到群/私聊。
- C8-2：`browser_action` 只校验首跳 URL，未拦截重定向和页面子请求访问内网。
- C8-3：`AI抓事件` 抓取回执直接发送，平台拒发时会让 middleware reject。
- C9-1：“帮我搜一下/搜一下”动作短句被当自包含搜索 query，绕过热/冷上下文裁决。
- C9-2：群管理员无法设置群聊 AI 主动回复概率，和命令自身权限说明冲突。
- C9-3：概率设置输入超过范围时没有清晰错误反馈。
- C9-4：`东雪莲群人格切换` 缺少名称时静默消耗消息。
- C9-5：未知模型名的 `切换xxx` 命令没有“未找到模型”反馈。
- C9-6：当前图片直读不复用已缓存图片，可能明明有缓存却回复“图片无法访问”。
- C9-7：历史图片两步工具链 `read_image_history -> analyze_historical_image` 中第二轮工具调用会被丢弃。
- C9-8：结构化 `mface` / 大表情无法复读，和 QQ 原生 face 复读体验不一致。
- C10-1：`create_scheduled_task` 默认 QQ 暴露且非危险，缺少执行级显式意图门禁。
- C10-2：计划工具默认 QQ 暴露且非危险，可写持久计划状态并触发完成推送。
- C10-3：`计划查看` 默认读取全局 active/recent 计划，跨用户/跨群泄露计划内容。
- C12-1：MCP `run_local_check` 的 `node -c <file>` 未限制允许根，可通过语法错误输出泄露任意本地文件片段。
- C12-2：Dashboard 启用 MCP 时默认同时允许工作区写入和本地检查，权限默认值过宽。

MCP 专项后，后续若进入修复，建议优先级调整为：先处理会外发/未来发消息/跨会话泄露/本地权限边界的 C8-1、C10-1、C10-2、C10-3、C12-1、C12-2；再处理直接影响主体验的 C9-1、C9-6、C9-7；最后统一收口命令反馈类 C9-2 到 C9-5 和复读体验 C9-8。

## 服务器第 1 轮（MCP 只读接入排查）

范围：按用户要求对服务器 `/root/koishi-app` 做 MCP 只读排查；只检查配置摘要、MCP stdio 协议握手、工具列表和执行层启用状态。不改服务器文件、不部署、不重启、不推送。

结论：服务器当前 MCP 工作台未启用，本轮未确认服务器运行态新增 bug；本地 C12-1/C12-2 仍是代码层风险，若服务器后续通过 Dashboard 启用 MCP，同样需要按 C12 建议先收口权限默认值和 `run_local_check` 路径边界。

证据：
- 服务器 `/root/koishi-app/data/ai-tool-config.json` 存在，但 MCP 摘要为 `enabled: false`，`exposeDangerousActions: false`，未显式配置 `allowWriteWorkspace` / `allowRunLocal`。
- 服务器上直接启动 `packages/koishi-plugin-dongxuelian-ai/lib/mcp/local-server.js` 并发送 JSON-RPC：
  - `initialize` 返回 serverInfo `dongxuelian-local-mcp` / `0.1.0`。
  - `tools/list` 能列出 `get_bot_health`、`get_agent_config`、`query_logs`、`read_file`、`write_file`、`edit_file`、`run_local_check` 等工具定义。
  - `tools/call get_bot_health` 返回错误：`本地 MCP 工作台已关闭，请先在 Dashboard Agent 窗口启用 MCP。`
- 因执行层 `ensureEnabled()` 拦截，未继续尝试服务器 `read_file`、`write_file`、`run_local_check` 等工具调用，避免为验证而开启或修改服务器 MCP 状态。

影响：
- 当前服务器运行态下，MCP 工具执行被关闭状态挡住；本轮没有发现已开启 MCP 导致的实际远端读写/运行暴露。
- 但服务器配置未显式写入 `allowWriteWorkspace: false` / `allowRunLocal: false`，代码默认值仍会在启用 MCP 时落到 C12-2 描述的写入/运行默认放开语义。
- 由于服务器代码同样暴露 `run_local_check node -c <file>`，一旦启用且允许本地检查，C12-1 的允许根外语法错误侧信道也适用于服务器环境。

建议修复：
- 在启用服务器 MCP 前先修 C12-1/C12-2，或临时确保服务器配置显式写入 `allowWriteWorkspace: false`、`allowRunLocal: false` 后再启用。
- Dashboard 启用 MCP 时应显示服务器风险提示：只读诊断、写工作区、本地命令运行需要拆成独立授权。
- 服务器排查如需继续验证 MCP 工具执行，应先由用户明确授权启用范围；默认继续保持只读、不改配置。

验证方式：
- 当前状态：服务器 `tools/call get_bot_health` 返回 MCP 未启用，写入/运行工具不应执行。
- 修复后：服务器仅启用 MCP 时，`get_bot_health` 应显示写入/运行为 false；`write_file` / `run_local_check` 返回关闭提示；显式授权后才可执行，且 C12-1 的允许根外路径应被拒绝。

## 服务器第 1 轮排除/暂不新增

- MCP stdio 工具定义可列出不等于工具已授权执行；当前执行层已被 `ensureEnabled()` 拦截，本轮不把工具列表存在本身记为服务器暴露 bug。
- 未为复现问题而修改服务器 `ai-tool-config.json`，也未启动 Dashboard 开关，因此不新增”服务器当前已开启写入/运行”的运行态问题。
- 本轮没有检查或修改 Koishi 进程、端口、部署状态和线上聊天链路；只覆盖 MCP 接入面。

---

## 综合复核（2026-05-24）

范围：将本文件（C8-C12）与《优化建议》（L1-L39、S1-S39）全部条目做交叉溯源，逐条回到当前代码确认是否仍然存在、已修复、或与另一份文档条目重叠。

### 一、本文件条目现状

| 编号 | 状态 | 备注 |
|------|------|------|
| C8-1 | 仍存在 | `send_file_to_user` QQ 默认启用、`dangerous:false`，路径 guard 存在但工具暴露面未收口 |
| C8-2 | 部分修复 | 首跳 DNS 校验 + `requestfinished` 后检 IP 已实现；但 post-redirect 仍是事后处理，请求已发出 |
| C8-3 | 仍存在 | `index.js:1337,1341` event dump 回执仍为裸 `session.send()`，与 L1 系列重叠 |
| C9-1 | 仍存在 | `router.js:11-15` EXPLICIT_SEARCH_RE 仍含裸动作短句 |
| C9-2 | 仍存在 | `index.js:1466` admin pre-gate 仍拦截群管理员概率设置 |
| C9-3 | 仍存在 | `admin-commands.js:203-228` 正则只匹配 0-100%，超范围无反馈 |
| C9-4 | 仍存在 | `handler.js:382` 无 exact-match 帮助分支 |
| C9-5 | 仍存在 | `handler.js:425-447` 未找到模型时无反馈 |
| C9-6 | 仍存在 | `vision.js` 当前图片不复用 image-store 缓存 |
| C9-7 | 仍存在 | `chat.js` 轻量工具只执行一轮，第二轮 tool_calls 被丢弃 |
| C9-8 | 仍存在 | `repeat.js:77-133` mface 归入 unsupported visual |
| C10-1 | 仍存在 | `scheduled-task-tools.js` create 无 intent gate，`dangerous:false` |
| C10-2 | 仍存在 | plan tools `dangerous:false`、QQ 默认暴露，finish_plan 可推送 |
| C10-3 | 仍存在 | `plan-engine.checkPlanStatus()` 无 owner/channel 过滤 |
| C12-1 | 仍存在 | `local-server.js:118-135` parseLocalCheckCommand 无路径 guard |
| C12-2 | 仍存在 | `config.js` MCP 默认 `allowWriteWorkspace:true`、`allowRunLocal:true` |

### 二、《优化建议》条目与本文件交叉对照

以下列出《优化建议》中与本文件有重叠或已被本文件覆盖的条目：

| 优化建议编号 | 本文件对应 | 现状 |
|-------------|-----------|------|
| L1 系列（bare send） | C8-3 重叠 | 仍存在：defense/index.js:216-218、handler.js:332-398、emotion-command.js:258、index.js:1337/1341 |
| L2-1（heavy search gate） | C9-1 相关但不同角度 | 仍存在：router.js 硬编码关键词 |
| L3（Windows colon） | 无重叠 | 仍存在：image-store.js:21-26 safeKey 允许冒号 |
| L9-1（send_file） | C8-1 重叠 | 仍存在 |
| L9-2（browser_action） | C8-2 重叠 | 部分修复 |
| L10（cancel_reminder） | — | 已修复：ownership 校验已实现 |
| L12（B站 English） | — | 仍存在：local-video-sender/index.js:551,571 英文 fallback |
| L13（random budget） | — | 仍存在 |
| L16（group URL） | — | 仍存在 |
| L22（private push） | — | 仍存在：无 per-user opt-in |
| L28（skill scanner） | — | 仍存在（by design，只扫固定目录） |
| L30-L31（timeout cancel） | — | 仍存在：queue.js/registry.js Promise.race 无 AbortController |
| L32（browser singleton） | C8-2 相关 | 仍存在：browser-action.js 模块级单例共享状态 |
| L33（memory enabled） | — | 仍存在：Agent memory tools 不检查 config.memory.enabled/adminOnly |
| L36（misfire policy） | — | 仍存在：misfirePolicy 字段存在但调度逻辑从未读取 |
| L38（active scene） | — | 已修复：优先级逻辑正确，highest-priority 标签是整体场景块 |
| L39（MCP diagnose） | C12-1 重叠 | 仍存在 |

### 三、已确认修复的条目

| 编号 | 修复内容 |
|------|---------|
| L7（reminder safety） | cancel_reminder 已有 `isReminderVisibleToContext()` ownership 校验 |
| L8（safety.check bypass） | safety gate 正确阻断 DANGEROUS_TOOLS，无 bypass |
| L10（cancel_reminder ownership） | 同 L7 |
| L21（contextPolicy） | Agent 会话无状态，contextPolicy 用于定时任务已实现 |
| L25（symlink） | path-guard 使用 `fsp.realpath()` 解析后校验 |
| L27（MCP node path） | `shell:false` + 正确参数数组 + Windows `npm.cmd` |
| L34（file upload） | file-safety.js 有 MAX_FILE_SIZE + BLOCKED_EXTENSIONS |
| L37（custom provider） | runtime-config.js loadConfig 正确读取自定义 provider |
| L38（active scene priority） | 优先级逻辑正确 |
| C10-2 中 create 部分 | scheduled task create 已限定 context 来源，不能为他人创建 |

### 四、综合优先级建议

按风险和影响排序：

**P0 — 安全/权限边界（会外发、泄露、越权）：**
1. C12-1 / L39：MCP `run_local_check` 路径穿越
2. C12-2：MCP 默认权限过宽
3. C10-3：计划查看跨用户/跨群泄露
4. C8-1 / L9-1：send_file_to_user QQ 默认暴露
5. C10-1：scheduled task 无 intent gate
6. C10-2：plan tools 无 intent gate + finish 推送
7. L32：browser singleton 跨会话状态共享
8. L22：private push 无 per-user consent
9. L33：Agent memory tools 不检查 enabled/adminOnly

**P1 — 主体验影响：**
10. C9-1 / L2：动作短句搜索绕过上下文裁决
11. C9-6：当前图片不复用缓存
12. C9-7：历史图片两步工具链第二轮被丢弃
13. L1 / C8-3：bare send 系列（defense、handler、emotion、event dump）
14. L30-L31：Promise.race timeout 无 cancel

**P2 — 命令反馈/UX：**
15. C9-2：群管理员概率设置被前置门槛拦截
16. C9-3：概率超范围无反馈
17. C9-4：群人格切换缺名称无提示
18. C9-5：未知模型名无反馈
19. C9-8：mface 无法复读
20. L3：Windows colon 在 image-store key
21. L12：B站 English fallback
22. L36：misfire policy 未生效

**P3 — 设计层/低频：**
23. L28：skill scanner 只扫固定目录
24. C8-2：browser redirect 事后处理（已有缓解）
