/**
 * MODULE: S5 低成本状态回复。
 * 职责: 生成固定资源状态文本，避免状态命令调用 AI 或工具。
 * 边界: 不修改任何资源状态，不执行管理操作。
 */
const { readResourceSnapshot } = require('../resource-scheduler/resource-snapshot') as typeof import('../resource-scheduler/resource-snapshot')
const { getResourceGateStatus } = require('../resource-gate/gate') as typeof import('../resource-gate/gate')
const { loadConfig } = require('../core/runtime-config') as typeof import('../core/runtime-config')
const { resolveProviderDefinition } = require('../core/provider-registry') as typeof import('../core/provider-registry')

interface ResourceGateMeta {
  kind?: unknown
}

const RESOURCE_TASK_LABELS: Record<string, string> = {
  daily_report: '日报生成',
  daily_report_render: '日报渲染',
  daily_summary: '日报摘要',
  agent_task: 'Agent 任务',
  dashboard_agent: '控制台 Agent 任务',
  agent_memory: '记忆整理',
  agent_memory_compaction: '记忆压缩',
  conversation_summary: '对话摘要',
  sensitive_cache_analysis: '敏感内容分析',
  emotion_render: '表情渲染',
  browser_action: '浏览器操作',
  voice_tts_generation: '语音生成',
  diagnostic_probe: '诊断检查',
  mcp_local_check: '本地检查',
  external_video_download: '外部视频下载',
  pet_bridge_chat: '宠物桥接聊天',
  media_image_analysis: '图片分析',
  media_file_analysis: '文件分析',
  media_voice_transcription: '语音转写',
  status_query: '状态查询',
  normal_chat: '普通聊天',
}

// --- 状态文案 --- //

// 格式化内存展示。
function formatMemory(available: unknown, total: unknown): string {
  if (typeof available !== 'number') return '暂无数据'
  return typeof total === 'number' ? `${available} / ${total} MB` : `${available} MB`
}

// 将正在执行的内部任务转换为群聊可读的中文描述。
function formatRunningTask(meta: ResourceGateMeta | null): string {
  if (!meta) return '无'
  const kind = String(meta.kind || '')
  if (kind === 'external_video_download') return '外部视频下载（正在下载 B 站视频）'
  return `${RESOURCE_TASK_LABELS[kind] || '其他任务'}（正在执行）`
}

// 读取默认聊天配置并生成供应商与模型名称。
async function formatDefaultChatModel(): Promise<string> {
  const config = await loadConfig()
  const provider = await resolveProviderDefinition(config.provider)
  const model = provider?.models.find(item => item.id === config.model || item.name === config.model)
  return `${provider?.name || config.provider} / ${model?.name || config.model}`
}

// --- 状态回复 --- //

// 生成固定资源状态文本，只读取运行时配置和状态，不调用模型或工具。
async function buildResourceStatusReply(): Promise<string> {
  const snapshot = readResourceSnapshot()
  const gate = getResourceGateStatus()
  return [
    '运行状态：正常',
    `当前任务：${formatRunningTask(gate.meta)}`,
    `可用内存：${formatMemory(snapshot.memAvailableMb, snapshot.memTotalMb)}`,
    `聊天 AI：${await formatDefaultChatModel()}`,
  ].join('\n')
}

export = {
  buildResourceStatusReply,
}
