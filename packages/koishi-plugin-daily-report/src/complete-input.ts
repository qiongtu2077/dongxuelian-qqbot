/** 完整入选消息的长度分批、结构化摘要、来源追踪与分层合并。 */
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime') as typeof import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { ReportAnalysisError } = loadManagementModule('daily.reportAnalysis')
const { redactSensitiveText } = loadManagementModule('core.redactor')
type Diagnostics = ConstructorParameters<typeof ReportAnalysisError>[3]

export interface InputMessage {
  analysisId?: number
  ts?: number
  time?: string
  user?: string
  userId?: string | number
  content?: string
}

export interface MessageFragment {
  id: string
  sourceId: number
  part: number
  partCount: number
  content: string
  text: string
}

export interface InputBatch { id: string; fragments: MessageFragment[]; text: string }
export interface DigestTopic { title: string; summary: string; participants: string[]; sourceIds: number[] }
export interface QuoteReference { sourceId: number; reason: string }
interface SummaryNode { id: string; topics: DigestTopic[]; quoteRefs: QuoteReference[]; sourceIds: Set<number> }

/** 引用表只存在于程序内，不把真实来源集合交给模型搬运。 */
export interface ExchangeContext {
  items: Map<string, DigestTopic>
  requiredRefs: string[]
  quotes: Map<string, QuoteReference>
  input: string
}

export interface AnalysisRuntime {
  deadlineMs: number
  workDeadlineMs?: number
  stageSoftDeadlinesMs?: Record<string, number>
  signal?: AbortSignal
  now?: () => number
  onProgress?: (diagnostics: Diagnostics) => void
  topicRange?: { min: number; max: number }
  request(system: string, input: string, maxTokens: number, extra: Record<string, unknown>): Promise<string>
}

const MAX_BATCH_CHARS = 4000
const MAX_BATCH_MESSAGES = 40
const INTERMEDIATE_CHARS = 1400

// --- 分批与画像取样 ---

// 连续拆分完整正文，UTF-16 代理对不会跨片段截断，前缀也计入4000字符。
export function packInputBatches(messages: InputMessage[]): InputBatch[] {
  const batches: InputBatch[] = []
  let fragments: MessageFragment[] = []
  let length = 14
  let sources = new Set<number>()
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]
    const sourceId = message.analysisId ?? messageIndex + 1
    if (sourceId !== messageIndex + 1) throw new Error('日报入选来源序号必须连续且唯一')
    const parts: string[] = []
    let body = ''
    let encodedLength = 0
    let part = 1
    const prefix = (partNumber: number): string => `[M${sourceId}:P${partNumber}] ${message.time || '-'} 用户ID=${String(message.userId || '-')}: `
    if (prefix(1).length >= MAX_BATCH_CHARS - 120) throw new Error('日报消息来源前缀过长')
    for (const character of String(message.content || '')) {
      const encodedCharacterLength = JSON.stringify(character).length - 2
      if (prefix(part).length + Math.max(body.length + character.length, encodedLength + encodedCharacterLength) > MAX_BATCH_CHARS - 100) {
        parts.push(body); body = ''; encodedLength = 0; part += 1
      }
      body += character
      encodedLength += encodedCharacterLength
    }
    if (body || !parts.length) parts.push(body)
    for (let index = 0; index < parts.length; index += 1) {
      const text = prefix(index + 1) + parts[index]
      // JSON转义及短引用也算真实请求长度，长正文不能在封装后突破输入预算。
      const itemLength = JSON.stringify({ ref: `r${fragments.length + 1}`, time: message.time || '', text: parts[index] }).length
      const extraLength = (fragments.length ? 1 : 0) + Math.max(text.length, itemLength)
      if (fragments.length && (length + extraLength > MAX_BATCH_CHARS || (!sources.has(sourceId) && sources.size >= MAX_BATCH_MESSAGES))) {
        batches.push({ id: `B${batches.length + 1}`, fragments, text: fragments.map(item => item.text).join('\n') })
        fragments = []; sources = new Set(); length = 14
      }
      fragments.push({ id: `${sourceId}:${index + 1}`, sourceId, part: index + 1, partCount: parts.length, content: parts[index], text })
      sources.add(sourceId)
      length += (fragments.length > 1 ? 1 : 0) + Math.max(text.length, itemLength)
    }
  }
  if (fragments.length) batches.push({ id: `B${batches.length + 1}`, fragments, text: fragments.map(item => item.text).join('\n') })
  return batches
}

// 在入选范围内按时间覆盖挑选成员例句，始末时段优先，重复正文只留一条。
export function selectRepresentativeMessages(messages: InputMessage[], userId: string, maxSamples = 15): InputMessage[] {
  const seen = new Set<string>()
  const candidates = messages.filter(message => {
    const text = String(message.content || '')
    if (String(message.userId || '') !== userId || !text || seen.has(text)) return false
    seen.add(text); return true
  }).sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
  if (candidates.length <= maxSamples) return candidates
  const chosen = new Set<number>([0, candidates.length - 1])
  const start = Number(candidates[0].ts || 0)
  const end = Number(candidates[candidates.length - 1].ts || 0)
  for (let i = 1; i < maxSamples - 1; i += 1) {
    const target = start + (end - start) * i / (maxSamples - 1)
    let nearest = 0
    for (let j = 1; j < candidates.length; j += 1) {
      if (Math.abs(Number(candidates[j].ts || 0) - target) < Math.abs(Number(candidates[nearest].ts || 0) - target)) nearest = j
    }
    chosen.add(nearest)
  }
  for (let i = 0; chosen.size < maxSamples && i < candidates.length; i += 1) chosen.add(Math.floor(i * candidates.length / maxSamples))
  return [...chosen].sort((a, b) => a - b).slice(0, maxSamples).map(index => candidates[index])
}

// --- 单元请求与结构校验 ---

// 解析明确 JSON 契约，允许常见代码块包装，不接受截断结构或空返回。
export function parseExchangeObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let value: unknown
  try { value = JSON.parse(trimmed) } catch {
    // 不记录模型正文，避免解析器把聊天内容或敏感字符串带进错误信息。
    throw new Error(`[JSON_PARSE] 返回不是完整JSON对象（长度${trimmed.length}），请检查引号、逗号与闭合括号`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('[FIELD_TYPE] 顶层必须为JSON对象')
  return value as Record<string, unknown>
}

// 读取逐条JSON记录：外层数组由程序组装，不猜测或补写模型遗漏的括号。
export function parseExchangeRecords(text: string): Record<string, unknown>[] {
  const input = text.trim().replace(/^```(?:jsonl?|ndjson)?\s*/i, '').replace(/\s*```$/, '')
  const records: Record<string, unknown>[] = []
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  let separatorPending = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (start === -1) {
      if (/\s/.test(character)) continue
      // 分隔符只影响传输排版；一条记录的内容、引用和闭合符仍按JSON原样校验。
      if (character === ',' && records.length && !separatorPending) { separatorPending = true; continue }
      if (character !== '{') throw new Error('[JSON_PARSE] 交换记录仅允许JSON对象，记录间可用空白或单个逗号分隔')
      separatorPending = false
      start = index; depth = 1; continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') quoted = true
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) {
      records.push(parseExchangeObject(input.slice(start, index + 1)))
      start = -1
    }
  }
  if (start !== -1) throw new Error('[JSON_PARSE] 最后一条交换记录未完整闭合')
  if (separatorPending) throw new Error('[JSON_PARSE] 最后一条交换记录之后不能添加逗号')
  if (!records.length || records[records.length - 1].kind !== 'end') throw new Error('[RECORD_INCOMPLETE] 缺少最后的end记录，不能把截断输出当作完成')
  assertExchangeFields(records[records.length - 1], ['kind'], 'end记录')
  if (records.slice(0, -1).some(record => record.kind === 'end')) throw new Error('[RECORD_ORDER] end记录只能在最后出现一次')
  return records.slice(0, -1)
}

// 必需字段按明确契约校验；适配器只读取这些字段，模型附加值没有数据所有权。
export function assertExchangeFields(value: Record<string, unknown>, fields: string[], path: string): void {
  for (const field of fields) if (!(field in value)) throw new Error(`[FIELD_MISSING] ${path}.${field}缺失`)
}

// 本次请求的短引用严格匹配；诊断仅输出格式受限的引用，其他字符串不泄露。
export function assertExchangeRef(value: unknown, allowed: Map<string, unknown>, path: string): string {
  if (typeof value !== 'string') throw new Error(`[FIELD_TYPE] ${path}必须是字符串引用，实际类型${typeof value}`)
  if (!allowed.has(value)) {
    const invalid = /^[rqpm]\d{1,6}$/.test(value) ? value : '非引用格式字符串'
    throw new Error(`[REF_UNKNOWN] ${path}未知引用${invalid}；允许${[...allowed.keys()].join(',') || '空集合'}`)
  }
  return value
}

// 将真实摘要转换为紧凑输入，私有来源和成员集合绝不进入模型请求。
export function createDigestExchange(topics: DigestTopic[], quotes: QuoteReference[], messages: InputMessage[]): ExchangeContext {
  const items = new Map(topics.map((topic, index) => [`r${index + 1}`, topic]))
  const requiredRefs = [...items.keys()]
  const quoteMap = new Map([...new Map(quotes.map(quote => [quote.sourceId, quote])).values()].map((quote, index) => [`r${topics.length + index + 1}`, quote]))
  // 话题与金句使用同一可信编号空间；引用金句原文也能提供真实话题依据，身份仍由程序恢复。
  for (const [ref, quote] of quoteMap) items.set(ref, { title: '', summary: '', sourceIds: [quote.sourceId],
    participants: [String(messages[quote.sourceId - 1].userId || '')].filter(Boolean) })
  return { items, requiredRefs, quotes: quoteMap, input: JSON.stringify({ items: requiredRefs.map(ref => ({ ref, title: items.get(ref)!.title, summary: items.get(ref)!.summary })),
    quotes: [...quoteMap].map(([ref, quote]) => ({ ref, reason: quote.reason, text: Array.from(String(messages[quote.sourceId - 1].content || '')).slice(0, 80).join('') })) }) }
}

// 统一校验摘要、合并与最终话题；全部输入覆盖只通过分组引用的并集确认一次。
export function readExchange(text: string, context: ExchangeContext, maxTextChars = Infinity, preserveUnselected = false): { topics: DigestTopic[]; quoteRefs: QuoteReference[]; retainedRefs: string[] } {
  const value: { groups: Record<string, unknown>[]; quotes: Record<string, unknown>[] } = { groups: [], quotes: [] }
  for (const record of parseExchangeRecords(text)) {
    if (record.kind !== 'group' && record.kind !== 'quote') throw new Error('[FIELD_TYPE] 话题交换记录kind只能为group或quote')
    const { kind, ...item } = record
    if (kind === 'group') {
      if (value.quotes.length) throw new Error('[RECORD_ORDER] group记录必须在quote记录之前')
      value.groups.push(item)
    } else value.quotes.push(item)
  }
  if (!value.groups.length) throw new Error('[FIELD_TYPE] 必须至少有一条group记录')
  if (value.quotes.length > 3) throw new Error('[FIELD_TYPE] quote记录最多3条')
  const covered = new Set<string>()
  const topics = value.groups.map((raw, index) => {
    const path = `groups[${index}]`
    const item = raw
    assertExchangeFields(item, ['title', 'summary', 'refs'], path)
    if (typeof item.title !== 'string' || !item.title.trim()) throw new Error(`[FIELD_TYPE] ${path}.title必须为非空文字`)
    if (typeof item.summary !== 'string' || !item.summary.trim()) throw new Error(`[FIELD_TYPE] ${path}.summary必须为非空文字；金句单独输出quote记录`)
    if (!Array.isArray(item.refs) || !item.refs.length) throw new Error(`[FIELD_TYPE] ${path}.refs必须为非空数组`)
    const sources = new Set<number>()
    const members = new Set<string>()
    const seen = new Set<string>()
    for (const rawRef of item.refs) {
      const ref = assertExchangeRef(rawRef, context.items, `${path}.refs`)
      if (seen.has(ref)) throw new Error(`[REF_DUPLICATE] ${path}.refs重复引用${ref}`)
      seen.add(ref); covered.add(ref)
      const parent = context.items.get(ref)!
      parent.sourceIds.forEach(id => sources.add(id))
      parent.participants.forEach(id => members.add(id))
    }
    return { title: item.title.trim(), summary: item.summary.trim(), sourceIds: [...sources], participants: [...members] }
  })
  const missing = context.requiredRefs.filter(ref => !covered.has(ref))
  if (missing.length && !preserveUnselected) throw new Error(`[REF_UNCOVERED] groups.refs未覆盖输入${missing.join(',')}`)
  // 合并是对已验证摘要的改写：未选中的节点保持原文和原来源，不推测它属于某个新话题。
  if (preserveUnselected) for (const ref of missing) {
    const original = context.items.get(ref)!
    topics.push({ title: original.title, summary: original.summary, participants: [...original.participants], sourceIds: [...original.sourceIds] })
  }
  const seenQuotes = new Set<number>()
  const quoteRefs = value.quotes.map((raw, index) => {
    const path = `quotes[${index}]`
    const item = raw
    assertExchangeFields(item, ['ref', 'reason'], path)
    const ref = assertExchangeRef(item.ref, context.quotes, `${path}.ref`)
    if (typeof item.reason !== 'string' || !item.reason.trim()) throw new Error(`[FIELD_TYPE] ${path}.reason必须为非空文字`)
    const sourceId = context.quotes.get(ref)!.sourceId
    if (seenQuotes.has(sourceId)) throw new Error(`[REF_DUPLICATE] ${path}重复引用同一原始消息`)
    seenQuotes.add(sourceId)
    return { sourceId, reason: item.reason.trim() }
  })
  // 文字预算与引用数量分离；覆盖4000条时私有来源集合不受模型字符预算挤压。
  if (JSON.stringify({ groups: topics.map(({ title, summary }) => ({ title, summary })), quotes: quoteRefs.map(({ reason }) => ({ reason })) }).length > maxTextChars) {
    throw new Error(`[TEXT_BUDGET] 摘要文字超过${maxTextChars}字符预算，请压缩文字并保留全部refs`)
  }
  return { topics, quoteRefs, retainedRefs: preserveUnselected ? missing : [] }
}

// 所有阶段沿用同一交换格式，不要求模型生成真实编号或额外消费集合。
export function exchangeInstructions(maxTextChars: number): string {
  return `仅输出逐条JSON对象，记录间用换行或单个逗号分隔，不写外层数组或groups/quotes包装。每个话题一条group记录：{"kind":"group","title":"主题","summary":"讨论内容和结论","refs":["输入条目的ref"]}。每条金句候选一条quote记录：{"kind":"quote","ref":"候选的ref","reason":"简短点评"}。没有金句则不输出quote。最后必须输出{"kind":"end"}，确认完整结束。
group记录必须有非空title、summary及非空refs；refs只选择本次items或quotes的可信字符串ref，每组不重复，各group的refs并集必须覆盖全部items，quotes只是补充依据。refs是完整归组清单，不是代表消息：正文重复的每条输入也必须逐个归组；合并两个主题时必须同时保留两个主题的全部ref。同一输入涉及多个主题可出现在不同group。金句摘选本身不是讨论话题。不要把全部主题合成宽泛类别，不编造讨论，不输出真实消息编号、用户ID或其他字段。
先建立每条输入的完整归组清单，再写标题和摘要；重复或组合条目也不能遗漏。输出前逐项核对items中的每个ref都在某个group的refs中，不能用“已概括相同内容”省略引用。
quote记录最多3条；只选择本次允许的金句ref，不返回原话或成员身份。所有标题、摘要、点评及其字段标点共不超过${maxTextChars}字符（refs另计），压缩文字而不遗漏引用。每条记录的所有数组和对象都必须闭合，最后的end之后不能再添加逗号。`
}

// 在同一硬截止内取消真实请求；单请求超时与整体600秒耗尽明确区分。
export async function requestAnalysisUnit<T>(runtime: AnalysisRuntime, diagnostics: Diagnostics, unit: { id: string; stage: string; sourceIds: number[]; timestamps: number[]; onSubmitted?: () => void },
  system: string, input: string, maxTokens: number, timeoutMs: number, validate: (text: string) => T): Promise<T> {
  const now = runtime.now || Date.now
  let retryCorrection = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (runtime.signal?.aborted) throw runtime.signal.reason || new Error('日报任务已取消')
    const remaining = runtime.deadlineMs - now()
    if (remaining <= 0) throw new ReportAnalysisError('日报运行总时限已耗尽', 'total_timeout', unit.stage, diagnostics)
    const workRemaining = Math.min(runtime.workDeadlineMs ?? runtime.deadlineMs, runtime.deadlineMs) - now()
    if (workRemaining <= 0) throw new ReportAnalysisError('日报分析预算已耗尽，已预留结果保存时间', 'generation_failed', unit.stage, diagnostics)
    const softDeadline = runtime.stageSoftDeadlinesMs?.[unit.stage]
    const budgetWarning = `${unit.stage}阶段已超过初始软预算，继续使用剩余运行时间`
    if (softDeadline !== undefined && now() >= softDeadline && !diagnostics.warnings.includes(budgetWarning)) diagnostics.warnings.push(budgetWarning)
    const requestStartedAt = now()
    const controller = new AbortController()
    const onOuterAbort = (): void => controller.abort(runtime.signal?.reason)
    runtime.signal?.addEventListener('abort', onOuterAbort, { once: true })
    const requestTimeout = Math.min(timeoutMs, remaining, workRemaining)
    const timer = setTimeout(() => controller.abort(new Error('日报单次模型请求超时')), requestTimeout)
    let onRequestAbort: (() => void) | undefined
    try {
      diagnostics.reportCallCount += 1
      if (attempt > 1) diagnostics.retryCount += 1
      diagnostics.inputChars += system.length + retryCorrection.length + input.length
      const aborted = new Promise<never>((_, reject) => {
        onRequestAbort = () => reject(controller.signal.reason || new Error('日报请求已取消'))
        controller.signal.addEventListener('abort', onRequestAbort, { once: true })
      })
      // 沿用既有采样设置；真实身份与覆盖始终以程序校验为准。
      const text = await Promise.race([runtime.request(system + retryCorrection, input, maxTokens, {
        signal: controller.signal, _timeoutMs: requestTimeout, temperature: 0.2,
        _onRequestAttempt: () => { diagnostics.requestCount += 1; unit.onSubmitted?.(); runtime.onProgress?.(diagnostics) },
        _onRequestUsage: (usage: { readable: boolean; promptTokens: number; completionTokens: number; totalTokens: number }) => {
          if (!usage.readable) return
          diagnostics.usageReadableRequests += 1
          diagnostics.tokenUsage.promptTokens += usage.promptTokens
          diagnostics.tokenUsage.completionTokens += usage.completionTokens
          diagnostics.tokenUsage.totalTokens += usage.totalTokens
        },
      }), aborted])
      if (now() >= runtime.deadlineMs) throw new Error('日报运行总时限已耗尽')
      if (runtime.workDeadlineMs !== undefined && now() >= runtime.workDeadlineMs) throw new Error('日报分析预算已耗尽，已预留结果保存时间')
      diagnostics.outputChars += text.length
      return validate(text)
    } catch (error) {
      if (runtime.signal?.aborted) throw runtime.signal.reason || error
      const isTotalTimeout = now() >= runtime.deadlineMs
      const isWorkExhausted = runtime.workDeadlineMs !== undefined && now() >= runtime.workDeadlineMs
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
      if (attempt === 2 || isTotalTimeout || isWorkExhausted) {
        const state = isTotalTimeout ? 'total_timeout' : 'failed'
        if (unit.stage === 'compression' || unit.stage === 'merge') diagnostics.stages.compression = state
        else if (unit.stage === 'basic' || unit.stage === 'full') diagnostics.stages[unit.stage] = state
        diagnostics.failedBatches.push({ id: unit.id, stage: unit.stage, firstSourceId: unit.sourceIds.length ? Math.min(...unit.sourceIds) : null,
          lastSourceId: unit.sourceIds.length ? Math.max(...unit.sourceIds) : null, firstTimestamp: unit.timestamps.length ? Math.min(...unit.timestamps) : null,
          lastTimestamp: unit.timestamps.length ? Math.max(...unit.timestamps) : null, attempts: attempt, error: message })
        const failure = new ReportAnalysisError(message, isTotalTimeout ? 'total_timeout' : 'generation_failed', unit.stage, diagnostics)
        runtime.onProgress?.(diagnostics)
        throw failure
      }
      diagnostics.warnings.push(`${unit.id}初次处理失败，重试一次：${message}`)
      // 仅反馈脱敏的校验原因，重试仍读取原始完整输入，不拼接未校验的模型正文。
      retryCorrection = `\n上次返回未通过校验：${message}。请重新核对以上明确格式、本次引用及摘要文字长度，输出全部独立JSON记录，不写外层包装，最后输出end记录。`
      runtime.onProgress?.(diagnostics)
    } finally {
      diagnostics.stageDurationsMs[unit.stage] = (diagnostics.stageDurationsMs[unit.stage] || 0) + Math.max(0, now() - requestStartedAt)
      clearTimeout(timer)
      runtime.signal?.removeEventListener('abort', onOuterAbort)
      if (onRequestAbort) controller.signal.removeEventListener('abort', onRequestAbort)
    }
  }
  throw new Error('日报处理单元没有执行')
}

// --- 完整摘要与分层合并 ---

// 所有入选片段完成后才累计原消息成功；不会因累计长度或批次数停止后续处理。
export async function summarizeCompleteInput(messages: InputMessage[], diagnostics: Diagnostics, runtime: AnalysisRuntime): Promise<{ digest: string; topics: DigestTopic[]; sourceIds: Set<number>; quoteRefs: QuoteReference[] }> {
  const batches = packInputBatches(messages)
  diagnostics.batchCount = batches.length
  diagnostics.analysisState = 'processing'
  diagnostics.stages.compression = 'processing'
  const submitted = new Set<number>()
  const completed = new Set<string>()
  const expectedParts = new Map<number, number>()
  const timestamps = new Map(messages.map((message, index) => [index + 1, message.ts]))
  const nodes: SummaryNode[] = []
  for (const batch of batches) for (const fragment of batch.fragments) expectedParts.set(fragment.sourceId, fragment.partCount)
  runtime.onProgress?.(diagnostics)
  for (const batch of batches) {
    const sourceIds = new Set(batch.fragments.map(fragment => fragment.sourceId))
    const items = new Map(batch.fragments.map((fragment, index) => ['r' + (index + 1), {
      title: '', summary: '', sourceIds: [fragment.sourceId], participants: [String(messages[fragment.sourceId - 1].userId || '')].filter(Boolean),
    }]))
    const quotes = new Map(batch.fragments.map((fragment, index) => ['r' + (index + 1), { sourceId: fragment.sourceId, reason: '' }]))
    const context: ExchangeContext = { items, requiredRefs: [...items.keys()], quotes, input: JSON.stringify({ items: batch.fragments.map((fragment, index) => ({
      ref: 'r' + (index + 1), time: messages[fragment.sourceId - 1].time || '',
      text: fragment.content,
    })) }) }
    const system = '你是群聊摘要助手。完整阅读本批所有消息片段，涵盖前中后时段和长正文尾部。金句可选择items的ref。\n' + exchangeInstructions(INTERMEDIATE_CHARS) + '\n必须归组的完整ref清单：' + [...items.keys()].join(',')
    const summary = await requestAnalysisUnit(runtime, diagnostics, { id: batch.id, stage: 'compression', sourceIds: [...sourceIds], timestamps: [...sourceIds].map(id => timestamps.get(id)).filter((value): value is number => typeof value === 'number'), onSubmitted: () => {
      for (const id of sourceIds) submitted.add(id)
      diagnostics.submittedMessageCount = submitted.size
      diagnostics.unprocessedCount = diagnostics.selectedMessageCount - submitted.size
    } }, system, context.input, 3000, 45000, response => readExchange(response, context, INTERMEDIATE_CHARS))
    for (const fragment of batch.fragments) completed.add(fragment.id)
    let summarized = 0
    for (const [id, count] of expectedParts) {
      let all = true
      for (let part = 1; part <= count; part += 1) if (!completed.has(id + ':' + part)) { all = false; break }
      if (all) summarized += 1
    }
    diagnostics.summarizedMessageCount = summarized
    nodes.push({ id: batch.id, ...summary, sourceIds })
    runtime.onProgress?.(diagnostics)
  }
  if (!nodes.length) throw new ReportAnalysisError('没有可分析的入选记录', 'generation_failed', 'compression', diagnostics)
  let current = nodes
  while (current.length > 1) {
    diagnostics.mergeLevels += 1
    const groups: SummaryNode[][] = []
    let group: SummaryNode[] = []
    for (const node of current) {
      const candidate = [...group, node]
      const input = createDigestExchange(candidate.flatMap(item => item.topics), candidate.flatMap(item => item.quoteRefs), messages).input
      if (group.length && (input.length > MAX_BATCH_CHARS || group.length >= 3)) { groups.push(group); group = [] }
      group.push(node)
    }
    if (group.length) groups.push(group)
    if (groups.length >= current.length) throw new ReportAnalysisError('摘要合并无法在长度预算内继续收敛', 'generation_failed', 'merge', diagnostics)
    const merged: SummaryNode[] = []
    for (const parents of groups) {
      if (parents.length === 1) { merged.push(parents[0]); continue }
      const sourceIds = new Set(parents.flatMap(node => [...node.sourceIds]))
      const id = 'L' + diagnostics.mergeLevels + '-' + (merged.length + 1)
      const final = groups.length === 1
      const maxChars = final ? 3000 : INTERMEDIATE_CHARS
      const context = createDigestExchange(parents.flatMap(node => node.topics), parents.flatMap(node => node.quoteRefs), messages)
      const system = '你是群聊摘要合并助手。完整合并items，保留不同时段的独立具体主题及结论，不只保留前半段。只合并同一具体讨论；不能仅因属于生活、技术、文艺等大类就吞并不同讨论。一个条目包含多个独立讨论时应拆开，可重复使用该条目的ref。未选中的条目由程序原样保留，因此请尽量完成合理合并以控制长度。金句只能选择quotes的ref。\n' + exchangeInstructions(maxChars) + '\n应归组的完整ref清单：' + [...context.items.keys()].join(',')
      const summary = await requestAnalysisUnit(runtime, diagnostics, { id, stage: 'merge', sourceIds: [...sourceIds], timestamps: [] },
        system + (final && runtime.topicRange ? `\n最终摘要须保留${runtime.topicRange.min}—${runtime.topicRange.max}个独立具体话题，不能再合成生活、技术等大类。` : ''),
        context.input, final ? 6000 : 3000, 45000, response => {
          const result = readExchange(response, context, maxChars, true)
          if (final && runtime.topicRange && (result.topics.length < runtime.topicRange.min || result.topics.length > runtime.topicRange.max)) {
            throw new Error(`最终摘要需要${runtime.topicRange.min}—${runtime.topicRange.max}个有依据的独立话题，实际${result.topics.length}个，请合理拆分或合并具体讨论并保留全部来源`)
          }
          return result
        })
      if (summary.retainedRefs.length) diagnostics.warnings.push(`${id}合并时${summary.retainedRefs.length}条已验证摘要未改写，程序已原样保留`)
      merged.push({ id, ...summary, sourceIds })
      runtime.onProgress?.(diagnostics)
    }
    current = merged
  }
  diagnostics.stages.compression = 'complete'
  const root = current[0]
  const topicSources = new Set(root.topics.flatMap(topic => topic.sourceIds))
  if (root.sourceIds.size !== messages.length || topicSources.size !== messages.length || diagnostics.summarizedMessageCount !== messages.length) {
    throw new ReportAnalysisError('最终摘要来源覆盖不完整', 'generation_failed', 'merge', diagnostics)
  }
  const digest = createDigestExchange(root.topics, root.quoteRefs, messages).input
  if (digest.length > MAX_BATCH_CHARS) throw new ReportAnalysisError('共同摘要超出最终输入预算', 'generation_failed', 'merge', diagnostics)
  runtime.onProgress?.(diagnostics)
  return { digest, topics: root.topics, sourceIds: root.sourceIds, quoteRefs: root.quoteRefs }
}
