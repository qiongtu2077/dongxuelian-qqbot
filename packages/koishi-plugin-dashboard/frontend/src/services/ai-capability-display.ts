import { AI_CAPABILITY_IDS, isAiCapability } from './ai-model-api-model'
import type { AiCapability, AiCapabilityModel } from './ai-model-api-model'

export interface CapabilityCheckDisplay {
  status: 'unverified' | 'failed' | 'confirmed'
  label: string
  reason: string
}

export interface CapabilityDetectionSummary {
  models: number
  total: number
  confirmed: number
  failed: number
  unverified: number
  failureReasons: Array<{ reason: string; count: number }>
}

// --- 单项结果与原因 ---

// 将探测器已有的错误原因解释为中文，并给出用户可以执行的检查步骤。
export function capabilityFailureReason(reason: string): string {
  const status = Number(reason.match(/\bHTTP (\d{3})\b/)?.[1])
  const explanations: Record<number, string> = {
    400: '供应商拒绝了检测参数（HTTP 400）。请核对模型名称，以及该接口接受的请求格式。',
    401: 'API Key 验证失败（HTTP 401）。请检查 Key 是否填写正确、已过期或已被停用。',
    403: '供应商拒绝访问（HTTP 403）。请检查 Key 的模型权限、账户余额和可用额度。',
    404: '未找到接口或模型（HTTP 404）。请核对请求地址和模型名称，并确认地址是否需要包含 /v1。',
    405: '该地址不接受检测请求（HTTP 405）。请核对填写的是否为 API 基础地址。',
    415: '接口不接受本次检测的数据格式（HTTP 415）。请向供应商确认该能力使用的接口格式。',
    429: '调用受到限制（HTTP 429）。请稍后重试，并检查供应商的调用频率和额度限制。',
    501: '供应商尚未提供这个接口（HTTP 501）。请向供应商确认该模型是否开放这项能力。',
  }
  if (explanations[status]) return explanations[status]
  if (status >= 500) return `供应商服务暂时异常（HTTP ${status}）。请稍后重新检测，持续失败时联系供应商。`
  if (status >= 300 && status < 400) return `请求地址发生跳转（HTTP ${status}）。请填写供应商提供的最终 API 基础地址。`
  if (status) return `供应商未接受本次检测（HTTP ${status}）。请核对请求地址、Key 权限和模型名称。`
  if (reason.includes('超时')) return '供应商未在检测时限内返回结果。请稍后重试；持续超时时检查服务器到供应商的网络连接。'
  if (reason === '网络或返回格式异常，待重新检测') return '未能连接供应商，或返回内容无法读取。请检查服务器网络和 API 请求地址后重试。'
  if (reason === '返回内容未能确认该能力') return '接口有返回，但内容不足以确认这项能力。请重新检测，或向供应商确认该模型是否支持此功能。'
  if (reason === '语音接口未返回音频数据') return '语音接口没有返回声音数据。请向供应商确认这个模型能否生成语音。'
  if (reason === '返回内容未确认是音频') return '语音接口返回的内容无法识别为音频。请检查该模型的语音输出格式是否兼容。'
  return '本次检测没有取得可用结果。请重试；持续失败时向供应商确认接口和模型是否兼容。'
}

// 区分从未检测、检测失败和已确认；接口报错不能作为模型明确不支持的证据。
export function capabilityCheckDisplay(model: AiCapabilityModel, capability: AiCapability, custom: boolean): CapabilityCheckDisplay {
  const check = model.capabilityChecks?.[capability]
  if (check?.status === 'supported') return { status: 'confirmed', label: '已确认', reason: '检测已通过，该模型可以使用这项能力。' }
  if (check && !(check.status === 'pending' && check.reason === '等待接口能力检测')) {
    return { status: 'failed', label: '检测失败', reason: capabilityFailureReason(check.reason) }
  }
  if (!check && !custom && model.capabilities.includes(capability)) {
    return { status: 'confirmed', label: '已确认', reason: '内置能力目录已确认该模型支持此功能；当前 Key 的调用权限仍需实际请求验证。' }
  }
  return { status: 'unverified', label: '未检测', reason: '尚未取得这项能力的检测结果。' }
}

// --- 汇总展示 ---

// 按每个模型的四项能力计数，并合并相同失败原因，避免整页重复报错。
export function summarizeCapabilityChecks(models: AiCapabilityModel[], custom: boolean): CapabilityDetectionSummary {
  const summary: CapabilityDetectionSummary = { models: models.length, total: 0, confirmed: 0, failed: 0, unverified: 0, failureReasons: [] }
  const failures = new Map<string, number>()
  for (const model of models) {
    for (const capability of AI_CAPABILITY_IDS) {
      if (!isAiCapability(capability)) continue
      const result = capabilityCheckDisplay(model, capability, custom)
      summary.total += 1
      summary[result.status] += 1
      if (result.status === 'failed') failures.set(result.reason, (failures.get(result.reason) || 0) + 1)
    }
  }
  summary.failureReasons = Array.from(failures, ([reason, count]) => ({ reason, count }))
  return summary
}

// 明确统计单位，避免把一次检测流程结束误报为所有能力验证成功。
export function capabilitySummaryText(summary: CapabilityDetectionSummary): string {
  return `${summary.models} 个模型，共 ${summary.total} 项能力：已确认 ${summary.confirmed} 项，检测失败 ${summary.failed} 项，未检测 ${summary.unverified} 项。`
}
