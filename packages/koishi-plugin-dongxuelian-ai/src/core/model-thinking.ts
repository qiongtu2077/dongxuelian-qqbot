/**
 * MODULE: 模型思考参数适配。
 * 职责: 按模型与调用协议生成思考参数，隔离主备模型的自动参数。
 * 边界: 不读写配置、不请求上游；未知模型跟随服务端默认设置。无运行时状态。
 */
interface ThinkingConfig {
  model?: string
  chatProtocol?: string
}

interface ModelThinkingArgs extends Record<string, unknown> {
  enable_thinking?: boolean
  thinking?: { type: 'enabled' | 'disabled' }
  reasoning_effort?: 'low' | 'high' | 'max'
}

interface ThinkingOptions {
  enabled?: boolean
  managed?: boolean
  explicitKeys?: string[]
}

// --- 模型能力；不以供应商名称或地址作为条件 ---

// 来源: https://help.aliyun.com/zh/model-studio/deep-thinking 。列出采用 enable_thinking 的混合思考型号。
const SWITCHABLE_THINKING_MODELS = new Set([
  'qwen-plus', 'qwen-plus-latest', 'qwen-flash',
  'qwen3.5-plus', 'qwen3.5-plus-2026-02-15', 'qwen3.5-flash', 'qwen3.5-flash-2026-02-23',
  'qwen3.6-plus', 'qwen3.6-plus-2026-04-02', 'qwen3.6-flash', 'qwen3.6-flash-2026-04-16', 'qwen3.6-35b-a3b',
  'qwen3.7-max', 'qwen3.7-max-2026-05-20', 'qwen3.7-max-2026-06-08',
  'qwen3.7-plus', 'qwen3.7-plus-2026-05-26', 'qwen3.7-flash', 'qwen3.7-flash-2026-07-15',
  'qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-flash', 'qwen3.8-27b',
])

// 来源: https://docs.z.ai/guides/capabilities/thinking-mode 。相同型号与协议复用能力，不绑定接入地址。
const REQUIRED_THINKING_MODELS = new Set(['glm-5.3', 'glm-5.3-flash'])

// 判断该模型在当前调用协议下是否支持已核实的 low/high/max 推理深度。
function supportsModelReasoningEffort(config: ThinkingConfig): boolean {
  return (!config.chatProtocol || config.chatProtocol === 'openai-chat')
    && REQUIRED_THINKING_MODELS.has(String(config.model || '').toLowerCase())
}

// --- 每节点请求参数 ---

// 强制思考模型忽略全局关闭设置；未核实组合不自动发送思考控制字段。
function buildModelThinkingArgs(config: ThinkingConfig, enabled: boolean = false): ModelThinkingArgs {
  if (config.chatProtocol && config.chatProtocol !== 'openai-chat') return {}
  if (supportsModelReasoningEffort(config)) return { thinking: { type: 'enabled' }, reasoning_effort: 'low' }
  if (SWITCHABLE_THINKING_MODELS.has(String(config.model || '').toLowerCase())) return { enable_thinking: enabled }
  return {}
}

// 清除上一节点自动生成的字段，再应用当前节点规则；调用方显式参数仍受强制思考约束。
function resolveModelThinkingFields(config: ThinkingConfig, fields: Record<string, unknown>, options: ThinkingOptions): Record<string, unknown> {
  const next = { ...fields }
  if (options.managed) {
    const explicit = new Set(options.explicitKeys || [])
    for (const key of ['enable_thinking', 'thinking', 'reasoning_effort']) if (!explicit.has(key)) delete next[key]
  }
  const result: Record<string, unknown> = { ...buildModelThinkingArgs(config, options.enabled), ...next }
  if (supportsModelReasoningEffort(config)) {
    // 旧调用方的 disabled/enable_thinking:false 不能覆盖模型硬约束，也不能跨节点污染。
    delete result.enable_thinking
    result.thinking = { type: 'enabled' }
    result.reasoning_effort = next.reasoning_effort ?? 'low'
  }
  return result
}

export = { buildModelThinkingArgs, resolveModelThinkingFields, supportsModelReasoningEffort }
