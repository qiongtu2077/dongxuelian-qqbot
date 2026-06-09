/**
 * MODULE: pet-bridge protocol handlers.
 * 职责: Dispatch and handle all pet bridge WebSocket message types (query/command/chat).
 * 边界: Reads AI state only through the AI public pet-bridge runtime adapter.
 *        Does NOT modify core plugin logic, handle Koishi sessions, or send messages on its own.
 */
const {
  getPetBridgeStatus,
  listPetBridgePersonas,
  getPetBridgeMemorySummary,
  listPetBridgeSummaryGroups,
  switchPetBridgeModel,
  setPetBridgeSearchEnabled,
  setPetBridgeThinkingEnabled,
  setPetBridgeMaintenanceEnabled,
  sendPetBridgeGroupMessage,
  managePetBridgeRandomWhitelist,
  switchPetBridgePersona,
  getCurrentPetBridgePersona,
  generatePetBridgeChatReply,
} = require('koishi-plugin-dongxuelian-ai/lib/public/pet-bridge-runtime') as typeof import('koishi-plugin-dongxuelian-ai/lib/public/pet-bridge-runtime')

interface BridgeRequest {
  id?: unknown
  type?: string
  action?: string
  payload?: unknown
}

interface BridgeResponse {
  type?: 'response'
  id?: unknown
  success: boolean
  payload?: Record<string, unknown>
  error?: string
}

interface BridgePayload {
  type?: string
  action?: string
  enabled?: boolean
  userId?: string
  channelKey?: string
  provider?: string
  model?: string
  groupId?: string | number
  text?: string
  whitelistAction?: string
  name?: string
  persona?: string
}

function asPayload(value: unknown): BridgePayload {
  return value && typeof value === 'object' ? value as BridgePayload : {}
}

// 资源忙时返回协议层可识别的低成本错误，不触发模型调用。
function buildPetBridgeBusyResponse(reason: unknown): BridgeResponse {
  return { success: false, payload: { error: 'RESOURCE_BUSY', reason } }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function handleStatus(): Promise<BridgeResponse> {
  return { success: true, payload: await getPetBridgeStatus() }
}

function handlePersonas(): BridgeResponse {
  return { success: true, payload: { personas: listPetBridgePersonas() } }
}

async function handleMemory(payload: BridgePayload): Promise<BridgeResponse> {
  const { userId, channelKey } = payload
  if (!userId) return { success: false, payload: { error: 'missing userId' } }
  const summary = await getPetBridgeMemorySummary(userId, channelKey || 'default')
  return { success: true, payload: { summary } }
}

function handleSummaries(): BridgeResponse {
  return { success: true, payload: { groups: listPetBridgeSummaryGroups() } }
}

async function handleSwitchModel(payload: BridgePayload): Promise<BridgeResponse> {
  const { provider, model } = payload
  return { success: true, payload: await switchPetBridgeModel(provider, model) }
}

function handleToggleSearch(payload: BridgePayload): BridgeResponse {
  const enabled = !!payload.enabled
  return { success: true, payload: setPetBridgeSearchEnabled(enabled) }
}

function handleToggleThinking(payload: BridgePayload): BridgeResponse {
  const enabled = !!payload.enabled
  return { success: true, payload: setPetBridgeThinkingEnabled(enabled) }
}

function handleToggleMaintenance(payload: BridgePayload): BridgeResponse {
  return { success: true, payload: setPetBridgeMaintenanceEnabled(!!payload.enabled) }
}

async function handleSendGroupMsg(payload: BridgePayload): Promise<BridgeResponse> {
  const { groupId, text } = payload
  if (!groupId || !text) return { success: false, payload: { error: 'missing groupId or text' } }
  if (!/^\d+$/.test(String(groupId))) return { success: false, payload: { error: 'groupId must be numeric' } }
  const result = await sendPetBridgeGroupMessage(groupId, text)
  return { success: !!result, payload: result || { error: 'send failed' } }
}

function handleManageWhitelist(payload: BridgePayload): BridgeResponse {
  const op = payload.whitelistAction || payload.action
  const result = managePetBridgeRandomWhitelist(op || '', payload.groupId)
  if (!result.ok) return { success: false, payload: { error: result.error || 'invalid action; use add/remove/list' } }
  return { success: true, payload: { whitelist: result.whitelist || [] } }
}

function handleSwitchPersona(payload: BridgePayload): BridgeResponse {
  const { name } = payload
  const result = switchPetBridgePersona(name || '')
  if (!result.ok) return { success: false, payload: { error: result.error || 'persona not found' } }
  return { success: true, payload: { persona: name } }
}

function handleGetCurrentPersona(): BridgeResponse {
  return { success: true, payload: { persona: getCurrentPetBridgePersona() } }
}

async function handleChat(payload: BridgePayload): Promise<BridgeResponse> {
  const { text, persona } = payload
  if (!text) return { success: false, payload: { error: 'missing text' } }

  const result = await generatePetBridgeChatReply({ text, persona, userId: payload.userId, channelKey: payload.channelKey })
  if (!result.ok) {
    if (result.error === 'RESOURCE_BUSY') return buildPetBridgeBusyResponse(result.reason || 'pet bridge chat resource busy')
    return { success: false, payload: { error: result.error || 'chat failed' } }
  }
  return { success: true, payload: { reply: result.reply } }
}

async function handleMessage(input: unknown): Promise<BridgeResponse> {
  const msg = input && typeof input === 'object' ? input as BridgeRequest : {}
  const { id, type } = msg
  const payload = asPayload(msg.payload)
  let result: BridgeResponse | null = null
  try {
    if (type === 'query') {
      const qt = payload && payload.type
      if (qt === 'status') result = await handleStatus()
      else if (qt === 'personas') result = handlePersonas()
      else if (qt === 'memory') result = await handleMemory(payload)
      else if (qt === 'summaries') result = handleSummaries()
      else if (qt === 'current_persona') result = handleGetCurrentPersona()
      else result = { success: false, payload: { error: 'unknown query type: ' + qt } }
    } else if (type === 'command') {
      const action = payload && payload.action
      if (action === 'switch_model') result = await handleSwitchModel(payload)
      else if (action === 'toggle_search') result = handleToggleSearch(payload)
      else if (action === 'toggle_thinking') result = handleToggleThinking(payload)
      else if (action === 'toggle_maintenance') result = handleToggleMaintenance(payload)
      else if (action === 'send_group_msg') result = await handleSendGroupMsg(payload)
      else if (action === 'manage_whitelist') result = handleManageWhitelist(payload)
      else if (action === 'switch_persona') result = handleSwitchPersona(payload)
      else result = { success: false, payload: { error: 'unknown command: ' + action } }
    } else if (type === 'chat') {
      result = await handleChat(payload)
    } else {
      result = { success: false, payload: { error: 'unknown message type: ' + type } }
    }
  } catch (err) {
    result = { success: false, payload: { error: getErrorMessage(err) } }
  }
  return { type: 'response', id: id != null ? id : null, ...result }
}

export = { handleMessage }
