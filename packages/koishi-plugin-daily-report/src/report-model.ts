/**
 * MODULE: 日报现有文字主备配置的单节点调用。
 * 职责: 只读冻结已配置主备节点及实际执行来源。
 * 边界: 不修改全局路由，不写凭据，不启用其他型号的原生结构参数。
 */
import { createHash } from 'crypto'
import { loadManagementModule } from 'koishi-plugin-dongxuelian-ai/lib/public/management-runtime'
import type { GroundedReportOptions } from './report-runner'
import { ReportRequestBoundaryError } from './report-request-pool'
import type { ReportClassificationCachePolicy } from './report-classification-cache'
import type { ReportStageCachePolicies, ReportCachedStage } from './report-stage-cache'

const { loadConfig } = loadManagementModule('core.runtimeConfig')
const { freezeChatRoute, requestChatCompletions, getChatFailureMetadata } = loadManagementModule('core.api')
// 一次冻结现有文字主备节点；每轮公共请求只含一个执行节点，不改全局配置。
export async function createGroundedModelRequest(options: { onlyConfiguredModel?: string; configuredNode?: { provider: string; model: string } } = {}): Promise<{ policyIdentity: string; routing: readonly { provider: string; model: string; baseURL: string; protocol: string }[]; classificationCachePolicy: ReportClassificationCachePolicy; stageCachePolicies: ReportStageCachePolicies; request: GroundedReportOptions['request'] }> {
  if (options.onlyConfiguredModel !== undefined && options.configuredNode !== undefined) throw new Error('日报限定型号与指定节点不能同时使用')
  const configured = options.configuredNode
    ? { ...loadManagementModule('core.aiCapabilityConfig').resolveConfiguredCapabilityModel('text', options.configuredNode.provider, options.configuredNode.model), searchEnabled: false }
    : await loadConfig()
  const existing = freezeChatRoute(configured, options.configuredNode ? [configured] : undefined)
  // 显式限定型号只从真实冻结配置选择唯一节点；不派生凭据，不回落到别的型号。
  const steps = options.onlyConfiguredModel === undefined ? existing.steps : existing.steps.filter(step => step.model === options.onlyConfiguredModel)
  if (options.onlyConfiguredModel !== undefined && (typeof options.onlyConfiguredModel !== 'string' || !options.onlyConfiguredModel || steps.length !== 1)) {
    throw new Error('日报限定型号必须唯一匹配已配置节点')
  }
  if (existing.capability !== 'text' || steps.length < 1 || steps.length > 2
    || steps.some(step => !step.apiKey || !step.provider || !step.model || !step.baseURL || step.chatProtocol !== 'openai-chat')) {
    throw new Error('日报需要一至两个明确配置的文字兼容聊天节点，不能猜凭据、协议或主备顺序')
  }
  // 单节点冻结重新规范执行索引；各节点独立保留自己的凭据、端点与型号。
  const primary = { ...steps[0], searchEnabled: false }
  const recovery = { ...(steps[1] || steps[0]), searchEnabled: false }
  // MiMo官方Chat接口默认开启思考；仅对已核实的此型号显式关闭，落实日报固定非思考参数。
  const primaryThinking = primary.model === 'mimo-v2.6-pro' ? { thinking: { type: 'disabled' } } : {}
  const recoveryThinking = recovery.model === 'mimo-v2.6-pro' ? { thinking: { type: 'disabled' } } : {}
  const primaryRoute = freezeChatRoute(primary, [primary]), recoveryRoute = freezeChatRoute(recovery, [recovery])
  const policyIdentity = createHash('sha256').update(JSON.stringify({ version: 'grounded-configured-models-3',
    primary: primaryRoute.identity, recovery: recoveryRoute.identity, temperature: 0.2, thinking: false, primaryThinking, recoveryThinking })).digest('hex')
  const classificationCachePolicy: ReportClassificationCachePolicy = { identity: policyIdentity,
    first: { routeIdentity: primaryRoute.identity, routeRevision: primaryRoute.routeRevision, provider: primary.provider!, model: primary.model, protocol: primary.chatProtocol! },
    recovery: { routeIdentity: recoveryRoute.identity, routeRevision: recoveryRoute.routeRevision, provider: recovery.provider!, model: recovery.model, protocol: recovery.chatProtocol! } }
  const stages: ReportCachedStage[] = ['grouping', 'selection', 'overview', 'quotes', 'portraits', 'review']
  const stageCachePolicies = Object.fromEntries(stages.map(stage => {
    const first = classificationCachePolicy.first
    return [stage, { first, recovery: classificationCachePolicy.recovery,
      identity: createHash('sha256').update(JSON.stringify({ version: 'grounded-configured-stage-models-3', stage, first: first.routeIdentity,
        recovery: recoveryRoute.identity, temperature: 0.2, thinking: false, primaryThinking, recoveryThinking })).digest('hex') }]
  })) as ReportStageCachePolicies
  const routing = Object.freeze([primary, recovery].map(node => Object.freeze({ provider: node.provider!, model: node.model, baseURL: node.baseURL, protocol: node.chatProtocol! })))
  return { policyIdentity, routing, classificationCachePolicy, stageCachePolicies, request: async (_stage, attempt, system, input, maxTokens, extra) => {
    if (attempt !== 1 && attempt !== 2) throw new ReportRequestBoundaryError('contract', '日报单元只允许首轮和一次恢复')
    const config = attempt === 2 ? recovery : primary, route = attempt === 2 ? recoveryRoute : primaryRoute
    let result: Awaited<ReturnType<typeof requestChatCompletions>>
    try {
      result = await requestChatCompletions([{ role: 'system', content: system }, { role: 'user', content: input }], config,
        { ...extra, ...(attempt === 2 ? recoveryThinking : primaryThinking), _frozenRoute: route, _frozenRouteStartStepIndex: 0,
          _thinkingEnabled: false, temperature: 0.2, max_tokens: maxTokens })
    } catch (error) {
      if (error instanceof ReportRequestBoundaryError) throw error
      throw new ReportRequestBoundaryError('upstream', error instanceof Error ? error.message : String(error), getChatFailureMetadata(error))
    }
    if (result.type !== 'text') throw new Error('日报固定节点必须返回文字对象，不能接受工具调用')
    return result.content
  } }
}
