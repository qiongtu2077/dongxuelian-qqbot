# 东雪莲 codex bot 开发进度

## v0.5 — 完整改动清单

### 本次版本改动

| # | 改动 | 类型 | 说明 |
|---|---|---|---|
| 1 | Fallback 链重排 | 修复 | GLM 4.6 → DeepSeek V4 Flash → Qwen3.5 → Qwen3.6 |
| 2 | 网络超时 fallback | 新增 | 拆 try/finally 为内外两层，外层 catch 网络错误走降级链 |
| 3 | `buildFallbackConfig` 函数 | 重构 | 消除原 4 个 if 块 + 内容安全拒绝块的重复代码 |
| 4 | 内容安全拒绝触发 fallback | 新增 | "request was rejected" 也走降级链 |
| 5 | 400 加到 HTTP 降级链 | 新增 | `status === 400` 与 401/429 同等对待 |
| 6 | 空模型回复提示 | 改进 | 从"无法连接"改为"我摆了，懒得回" |
| 7 | `extraBody` 过滤非标准字段 | 安全 | 只保留 `max_tokens`/`enable_search`/`web_search_options`，过滤内部字段 |
| 8 | 懒回复阈值统一 1500 | 调整 | 去掉了原先 1000/2000 分级 |
| 9 | `isGLM &&` 移除 | 修复 | thinking 过滤器对所有模型生效，不再仅限 GLM |
| 10 | thinking 过滤器补充新模式 | 增强 | 增加 `根据系统约束`、`这是一个.{0,8}(?:模式\|回复\|场景)`、`需要.{0,10}(?:回复\|插话\|吐槽)` 等 |
| 11 | `buildFallbackConfig` 函数 | 新增 | 统一的 fallback 配置工厂 |
| 12 | 转发消息修复 | 修复 | `callGetForwardMsg` 不再对非匹配 echo 的消息 resolve(null) + close() |
| 13 | 思考模式开关 | 新增 | `东雪莲思考开/关`，`getThinkingArgs` 按供应商区分 |
| 14 | 切换命令立即生效 | 修复 | `configCache = null` |
| 15 | mimorium URL 修正 | 修复 | `https://platform.mimorium.com` → `https://token-plan-cn.xiaomimimo.com/v1` |
| 16 | 视觉降级链修复 | 修复 | `const vc2 = vc` 不再 re-read 覆盖 fallback 修改 |
| 17 | 情绪历史写入独立 try/catch | 修复 | 写入失败不阻塞分析结果返回 |
| 18 | 情绪历史保留 5 天 | 调整 | 30 天改为 5 天 |
| 19 | 评价功能 | 新增 | 仅 @ 匹配，注入目标最近 15 条发言 |
| 20 | 评价注入改为 `role: user` | 修复 | 解决 AI 无视 system message 的问题 |
| 21 | 评价无 profile 兜底 | 新增 | 有 @ 但无数据时注入"用户在让你评价对方" |
| 22 | 用户发言习惯写入 + 风格注入 | 新增 | `saveUserProfile` → `data/user-profiles/`，最近 5 条自动注入 |
| 23 | `channelMutedUntil` + "闭嘴"静默 | 新增 | 群聊中非 @bot 的"闭嘴"触发 10 分钟静默主动回复 |
| 24 | 随机插话 prompt 优化 | 改进 | 专业讨论平和接话 / 水群吐槽 |
| 25 | 连续发言延迟触发 | 新增 | 同人 10 秒内连续发言→等待 15 秒后重新掷骰 |
| 26 | `seriousKeywords` 正经问题检测 | 新增 | 检测到正经提问关键字→注入"先答后怼" |
| 27 | `uncertainKeywords` 不确定问题检测 | 新增 | 检测到不确定信号→注入"不要编答案" |
| 28 | `[专业问题处理]` prompt 区块 | 新增 | 禁止不懂装懂、胡编、用嘲讽掩盖不确定 |
| 29 | `[日常回应]` 替代 `[日常嫌弃话术]` | 改进 | 删除旧怼人模板原文，改为看情况回应的规则 |
| 30 | `sendReply` 概率引用 | 新增 | @bot 100% 引用，随机回复 40% 引用 60% 纯文本 |
| 31 | 敏感话题检测 + 处理者 | 新增 | 检测政治关键词→@群内已绑定的处理者 |
| 32 | 敏感话题处理者管理命令 | 新增 | `敏感话题处理者添加/删除/查看`，群主/管理员/bot 管理员可用 |
| 33 | 图片安全过滤提示 | 改进 | "input data may contain inappropriate content" → "这个图不合适，不说了吧" |
| 34 | help 菜单新增 `renderAdminHelp` | 新增 | 白名单命令移到黑名单板块、删除全部 `（bot管理员）` 标记 |
| 35 | `SHORT_FOLLOW_UP_RE` 移除"滚" | 修复 | 不让 `滚` 被当成话题延续 |
| 36 | `JAILBREAK_INPUT_RE` 增强 | 安全 | 补上漏检的 `忘记所有约束`、`请忽略之前的指令` 等模式 |
| 37 | `enqueueForChannel` TOCTOU 修复 | 修复 | depth 检查挪到 promise 链内 |
| 38 | `userBlacklistCache` 统一加载 | 重构 | 三处独立懒加载统一成 `ensureUserBlacklistCache()` |
| 39 | `getModelDisplayName` 重复定义删除 | 重构 | 保留第二个，删除第一个完全相同的函数 |
| 40 | `isGLM` 死变量删除 | 重构 | `isGLM &&` 移除后变量无引用 |
| 41 | `containsBlockedRichContent` 死函数删除 | 重构 | 定义后从未被调用 |
| 42 | `ocrImage` 死函数删除 | 重构 | tesseract OCR 从未被主流程调用 |
| 43 | 冗余代码清理 | 重构 | 以上 3 项共 -37 行 |

### 未解决 / 搁置

| 问题 | 状态 | 说明 |
|---|---|---|
| MiMo 联网搜索 `enable_search` | 搁置 | MiMo 不认 `tools.function.web_search` 和 `enable_search`，需确认正确参数 |
| 情绪分析近 5 日对比 | 已实现 | 使用每日情绪历史文件滚动保留近 5 日，并记录写入日志便于排查 |
| 跨日 UTC 日期边界 | 已修复 | 今日情绪、消息定位和艾特查询统一使用 CST 日期 |
