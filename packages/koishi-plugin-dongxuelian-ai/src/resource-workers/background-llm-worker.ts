/**
 * MODULE: 后台 LLM worker 执行器。
 * 职责: 在 S2 agent worker 进程中执行表达抽象、对话摘要和敏感缓存分析。
 * 边界: 不注册消息入口，不发送 QQ；Koishi 主进程只消费文件态结果。
 */
const fs = require('fs')
const {
  CONVERSATION_SUMMARY_INTERVAL,
  MEMORY_HISTORY_LIMIT,
  GLM_KEY_FILE,
  DASHSCOPE_KEY_FILE,
  PROVIDERS,
  SENSITIVE_CACHE_PREFIX,
} = require('../core/constants') as typeof import('../core/constants')
const { readTextFile, safeChannelKey } = require('../core/utils') as typeof import('../core/utils')
const { requestChatCompletions } = require('../core/api') as typeof import('../core/api')
const { loadConfig } = require('../core/runtime-config') as typeof import('../core/runtime-config')
const {
  readConversationDisk,
  writeConversationDisk,
  writePendingSensitiveAlert,
} = require('../conversation') as typeof import('../conversation')

interface SensitiveCacheData {
  messages?: Array<{ speakerName?: string; userId?: string; content?: string; ts?: number }>
}

interface BackgroundLlmPayloadLike extends Record<string, unknown> {
  channels?: unknown
  selfUserId?: unknown
  botName?: unknown
  key?: unknown
  channelKey?: unknown
}

interface BackgroundLlmTaskLike extends Record<string, unknown> {
  id?: string
  kind?: string
  channelKey?: string
  payload?: BackgroundLlmPayloadLike
}

const MAX_SENSITIVE_CACHE_FILE_BYTES = Math.max(64 * 1024, Math.min(4 * 1024 * 1024, parseInt(String(process.env.DONGXUELIAN_SENSITIVE_CACHE_MAX_BYTES || 512 * 1024), 10) || 512 * 1024))

function toBackgroundRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function formatConversationSummaryMessage(message: unknown): string {
  const record = toBackgroundRecord(message)
  return `${String(record.role)}: ${String(record.content)}`
}

// 从 ChatCompletion 结果中取文本内容。
function getBackgroundChatResultContent(resultObj: Awaited<ReturnType<typeof requestChatCompletions>>): string {
  return typeof resultObj === 'string' ? resultObj : (resultObj.type === 'text' ? resultObj.content : '')
}

// 执行对话摘要压缩并写回 conversation disk。
async function runConversationSummaryWorkerTask(task: BackgroundLlmTaskLike): Promise<Record<string, unknown>> {
  const key = String(task?.payload?.key || '')
  if (!key) return { mode: 'conversation_summary', summarized: false, reason: 'empty-key' }
  const diskData = readConversationDisk(key)
  if (!diskData || !Array.isArray(diskData.messages) || diskData.messages.length < 5 + MEMORY_HISTORY_LIMIT) {
    return { mode: 'conversation_summary', summarized: false, reason: 'not-enough-messages' }
  }

  const targets = diskData.messages.slice(0, Math.max(0, diskData.messages.length - MEMORY_HISTORY_LIMIT))
  const text = targets.map(formatConversationSummaryMessage).join('\n').slice(0, 4000)
  if (!text.trim()) return { mode: 'conversation_summary', summarized: false, reason: 'empty-summary-input' }

  const cfg = await loadConfig()
  const resultObj = await requestChatCompletions([
    { role: 'system', content: '将以下对话压缩成一段200字以内的摘要，保留关键话题变化和重要信息。用中文，用第三人称。' },
    { role: 'user', content: text },
  ], cfg, { max_tokens: 300, _fallbackSet: 'lightweight' })
  const summary = getBackgroundChatResultContent(resultObj).trim()
  if (!summary) return { mode: 'conversation_summary', summarized: false, reason: 'empty-model-result' }

  const freshData = readConversationDisk(key)
  if (!freshData) return { mode: 'conversation_summary', summarized: false, reason: 'conversation-disk-missing-after-llm' }
  freshData.summary = summary
  freshData.summaryTotal = freshData.totalCount
  writeConversationDisk(key, freshData)
  return {
    mode: 'conversation_summary',
    summarized: true,
    key,
    summaryTotal: freshData.summaryTotal || 0,
    interval: CONVERSATION_SUMMARY_INTERVAL,
    reason: 'conversation summary completed',
  }
}

// 读取敏感缓存文件，过大时清理并返回空。
function readSensitiveCache(channelKey: string): SensitiveCacheData | null {
  const safeKey = safeChannelKey(channelKey)
  const file = SENSITIVE_CACHE_PREFIX + safeKey + '.json'
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_SENSITIVE_CACHE_FILE_BYTES) {
      try { fs.unlinkSync(file) } catch { /* non-critical: oversized sensitive cache cleanup */ }
      return null
    }
    return JSON.parse(fs.readFileSync(file, 'utf8') || '{}') as SensitiveCacheData
  } catch {
    return null
  }
}

// 清理已经分析过的敏感缓存文件。
function unlinkSensitiveCache(channelKey: string): void {
  const file = SENSITIVE_CACHE_PREFIX + safeChannelKey(channelKey) + '.json'
  try { fs.unlinkSync(file) } catch { /* non-critical: best-effort sensitive cache cleanup */ }
}

// 构造敏感缓存分析提示词。
function buildSensitiveAnalysisPrompt(): string {
  return ['你是一个群聊内容审查员。你的任务是判断一条消息是否包含"明显违规的政治攻击性内容"。', '请严格按照下面规则执行。', '', '一、任务目标', '你只需要做一件事：判断消息里是否存在明显的、带恶意的、指向政治制度、执政党、政治体系、敏感政治事件、政治人物或政治权威机构的攻击、讽刺、影射、谣言传播或煽动性表达。', '如果有，回复：SENSITIVE；如果没有，回复：CLEAN', '除了这一个词，不要输出任何别的内容。', '', '二、什么算违规政治内容', '以下内容，原则上判为 SENSITIVE：', '1. 用隐喻、反讽、谐音、缩写、代称、梗图话术等方式，明显攻击政治制度、执政党或政治体系。', '2. 阴阳怪气地讨论敏感政治事件、政治决策、政治路线，并且带有明显恶意导向。', '3. 传播针对政治体系、政治权威、执政组织或国家治理的恶意谣言、编造信息、煽动性说法。', '4. 对政治人物、领导人、政权机构进行明显侮辱、辱骂、嘲讽或恶意丑化。', '5. 借社会议题、公共事件、历史事件进行明显政治影射，并且攻击指向清晰。', '6. 表面像玩笑、段子或梗，实质是在影射、贬损、讽刺政治体制或敏感政治对象。', '7. 使用"大家都懂""不能明说""你品你细品"之类表达，配合上下文明显指向政治攻击。', '8. 借转述、引用、截图描述等形式，继续传播带恶意的政治讽刺、政治攻击或政治谣言。', '', '三、什么不算违规政治内容', '以下内容，原则上判为 CLEAN：', '1. 日常吐槽工作压力、生活压力、学习压力、工资低、加班多、就业难、房租高、物价高等社会生活问题。', '2. 正常讨论劳动法、社保、公积金、教育、医疗、经济、就业、税收等公共政策，只要语气中性，没有明显政治攻击。', '3. 单纯提到国家、政府、领导人、部门、政策、新闻事件，但语气客观、中立、正面，或只是事实陈述。', '4. 对具体办事流程、行政服务、城市管理、企业经营、学校制度的普通抱怨，如果没有明显上升到政治恶意攻击。', '5. 网络段子、玩梗、夸张吐槽、情绪发泄，只要没有明确政治指向，或政治指向不清晰。', '6. 对现实环境表达失望、无奈、疲惫、抱怨，只要主要是在说个人处境，而不是借机攻击政治体系。', '7. 讨论历史、国际关系、法律法规、时事新闻，只要表达方式正常，不带明显侮辱、煽动、恶意讽刺。', '8. 批评某个具体社会现象、公司、平台、行业、学校、单位、地方执行问题，但没有清楚指向政治制度攻击。', '', '四、重点判定原则', '1. 只抓"明显恶意"。2. 不确定就放过。3. 宁可漏过，不要误报。4. 核心不是看内容负面不负面，而是看这种负面是否明确指向政治制度、执政组织、政治人物或敏感政治议题，并且带明显恶意。5. 不要过度联想。', '五、容易误判的情况：以下通常应判 CLEAN：普通骂生活苦；对某个具体规定有意见；使用夸张、反话、玩梗语气但不足以证明在攻击政治。', '六、输出要求：只能输出以下两种结果之一：SENSITIVE 或 CLEAN。不要输出解释。', ''].join('\n')
}

// 调用轻量模型判断敏感缓存。
async function callSensitiveAnalysisModel(text: string): Promise<string> {
  const messages = [{ role: 'system', content: buildSensitiveAnalysisPrompt() }, { role: 'user', content: text }]
  const models = [
    { provider: 'glm', model: 'glm-4.6v-flash', keyFile: GLM_KEY_FILE },
    { provider: 'dashscope', model: 'qwen-turbo', keyFile: DASHSCOPE_KEY_FILE },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: DASHSCOPE_KEY_FILE },
    { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: null },
  ]
  for (const am of models) {
    const provDef = PROVIDERS[am.provider]
    if (!provDef) continue
    try {
      const cfg = await loadConfig()
      const apiKey = am.keyFile ? (await readTextFile(am.keyFile).catch(() => '') || cfg.apiKey).replace(/[\r\n]+/g, '') : cfg.apiKey
      if (!apiKey) continue
      const result = await requestChatCompletions(messages, { model: am.model, baseURL: provDef.baseURL.replace(/\/+$/, ''), apiKey, provider: am.provider }, { max_tokens: 20, _fallbackSet: 'lightweight' })
      const content = getBackgroundChatResultContent(result)
      if (content) return content
    } catch {
      // Try the next lightweight model. The final worker result records empty output if all fail.
    }
  }
  return ''
}

// 执行敏感缓存分析；命中后写文件态 alert 供主进程消费。
async function runSensitiveCacheAnalysisWorkerTask(task: BackgroundLlmTaskLike): Promise<Record<string, unknown>> {
  const channelKey = String(task?.payload?.channelKey || task?.channelKey || '')
  if (!channelKey) return { mode: 'sensitive_cache_analysis', analyzed: false, reason: 'empty-channel-key' }
  const data = readSensitiveCache(channelKey)
  if (!data || !Array.isArray(data.messages) || data.messages.length < 5) {
    return { mode: 'sensitive_cache_analysis', analyzed: false, reason: 'not-enough-messages' }
  }
  const text = data.messages.slice(-30).map(message => `${message.userId ? `${message.speakerName}：` : ''}${message.content}`).join('\n').slice(0, 3000)
  const result = await callSensitiveAnalysisModel(text)
  const sensitive = /SENSITIVE/i.test(result)
  if (sensitive) writePendingSensitiveAlert(channelKey, { sourceTaskId: String(task?.id || ''), result: result.slice(0, 80) })
  unlinkSensitiveCache(channelKey)
  return {
    mode: 'sensitive_cache_analysis',
    analyzed: true,
    sensitive,
    result: result.slice(0, 80),
    messageCount: data.messages.length,
    reason: sensitive ? 'sensitive alert written' : 'sensitive cache clean',
  }
}

// 根据任务 kind 分发后台 LLM 执行器。
async function runBackgroundLlmWorkerTask(task: BackgroundLlmTaskLike): Promise<Record<string, unknown>> {
  if (task?.kind === 'conversation_summary') return runConversationSummaryWorkerTask(task)
  if (task?.kind === 'sensitive_cache_analysis') return runSensitiveCacheAnalysisWorkerTask(task)
  throw new Error(`unsupported background LLM task kind: ${String(task?.kind || '')}`)
}

export = {
  runBackgroundLlmWorkerTask,
  runConversationSummaryWorkerTask,
  runSensitiveCacheAnalysisWorkerTask,
}
