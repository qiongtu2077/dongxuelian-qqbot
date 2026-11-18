const BASE = '/dashboard/api'
const SERVER_TOKEN_KEY = 'dashboard_server_token'
const LEGACY_ADMIN_TOKEN_KEY = 'dashboard_admin_token'

import type {
  ApiMessageData,
  ApiResult,
  CommandGroup,
  FeatureInfo,
  GroupNamesResponse,
  JsonObject,
  StatusData,
  WhitelistMap,
} from './types'
import { errorMessage } from './types'
import type { GroupSettings, GroupSettingsResponse, ParticipationChange, ParticipationResponse } from './services/participation-model'
import type {
  AiCapability,
  AiDiscoveryResponse,
  AiModelApiConfigResponse,
  AiPriorityResponse,
  AiPriorityStep,
  CapabilityUsageResponse,
} from './services/ai-model-api-model'

function getAdminToken(): string {
  try {
    const raw = localStorage.getItem(SERVER_TOKEN_KEY) || localStorage.getItem(LEGACY_ADMIN_TOKEN_KEY)
    if (!raw) return ''
    const { token, expires } = JSON.parse(raw)
    if (Date.now() > expires) { clearAdminToken(); return '' }
    return token
  } catch { return '' }
}

function setAdminToken(token: string) {
  // 12 小时有效期
  const data = JSON.stringify({ token, expires: Date.now() + 43200000 })
  localStorage.setItem(SERVER_TOKEN_KEY, data)
  localStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY)
}

function clearAdminToken() {
  localStorage.removeItem(SERVER_TOKEN_KEY)
  localStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY)
}

// Clears both authentication layers and tells the application why login is required again.
function clearDashboardSession(reason = '登录已失效，请重新登录') {
  localStorage.removeItem('dashboard_token')
  clearAdminToken()
  window.dispatchEvent(new CustomEvent('auth-expired', { detail: { reason } }))
}

function headers(admin = false): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = localStorage.getItem('dashboard_token')
  if (token) h['Authorization'] = 'Bearer ' + token
  if (admin) {
    const adminToken = getAdminToken()
    if (adminToken) h['X-Admin-Token'] = adminToken
  }
  return h
}

function handle401(res: Response): boolean {
  if (res.status === 401) {
    clearDashboardSession()
    return true
  }
  return false
}

export function isAdminRequired(res: { code?: string, data?: unknown } | null | undefined): boolean {
  if (!res) return false
  if (res.code === 'ADMIN_REQUIRED') return true
  const data = res.data
  return !!data && typeof data === 'object' && !Array.isArray(data) && (data as { code?: unknown }).code === 'ADMIN_REQUIRED'
}

// 将调用方取消转发给超时控制器，完成时释放计时器及监听。
function withTimeout(ms = 10000, callerSignal?: AbortSignal) {
  const ctrl = new AbortController()
  const cancel = () => ctrl.abort()
  if (callerSignal?.aborted) cancel()
  else callerSignal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, stopTimer: () => clearTimeout(timer), clear: () => { clearTimeout(timer); callerSignal?.removeEventListener('abort', cancel) } }
}

// 读取请求同时接受页面取消和接口超时，过期响应不能清除当前登录状态。
async function get<T = unknown>(path: string, admin = false, timeoutMs = 10000, callerSignal?: AbortSignal): Promise<ApiResult<T | null>> {
  const { signal, clear, stopTimer } = withTimeout(timeoutMs, callerSignal)
  try {
    const res = await fetch(BASE + path, { headers: headers(admin), signal })
    stopTimer()
    if (callerSignal?.aborted) return { ok: false, data: null }
    if (res.status === 403) { const j = await res.json(); return { ok: false, data: j, code: j.code } }
    if (handle401(res)) return { ok: false, data: null }
    return { ok: res.ok, data: await res.json() }
  } catch (e) {
    if (callerSignal?.aborted) return { ok: false, data: null }
    if (e instanceof DOMException && e.name === 'AbortError') return { ok: false, data: { message: '请求超时' } as T }
    return { ok: false, data: { message: errorMessage(e) } as T }
  } finally { clear() }
}

async function put<T = unknown>(path: string, data: unknown, admin = false): Promise<ApiResult<T | null>> {
  const { signal, clear } = withTimeout()
  try {
    const res = await fetch(BASE + path, { method: 'PUT', headers: headers(admin), body: JSON.stringify(data), signal })
    clear()
    if (res.status === 403) { const j = await res.json(); return { ok: false, data: j, code: j.code } }
    if (handle401(res)) return { ok: false, data: null }
    return { ok: res.ok, data: await res.json() }
  } catch (e) {
    clear()
    if (e instanceof DOMException && e.name === 'AbortError') return { ok: false, data: { message: '请求超时' } as T }
    return { ok: false, data: { message: errorMessage(e) } as T }
  }
}

async function del<T = unknown>(path: string, data: unknown, admin = false): Promise<ApiResult<T | null>> {
  const { signal, clear } = withTimeout()
  try {
    const res = await fetch(BASE + path, { method: 'DELETE', headers: headers(admin), body: JSON.stringify(data), signal })
    clear()
    if (res.status === 403) { const j = await res.json(); return { ok: false, data: j, code: j.code } }
    if (handle401(res)) return { ok: false, data: null }
    return { ok: res.ok, data: await res.json() }
  } catch (e) {
    clear()
    if (e instanceof DOMException && e.name === 'AbortError') return { ok: false, data: { message: '请求超时' } as T }
    return { ok: false, data: { message: errorMessage(e) } as T }
  }
}

// 允许页面结束自己的等待，并忽略已经取消的启动请求的鉴权结果。
async function post<T = unknown>(path: string, data: unknown, admin = false, timeoutMs = 10000, callerSignal?: AbortSignal): Promise<ApiResult<T | null>> {
  const { signal, clear, stopTimer } = withTimeout(timeoutMs, callerSignal)
  try {
    const res = await fetch(BASE + path, { method: 'POST', headers: headers(admin), body: JSON.stringify(data), signal })
    stopTimer()
    if (callerSignal?.aborted) return { ok: false, data: null }
    if (res.status === 403) { const j = await res.json(); return { ok: false, data: j, code: j.code } }
    if (handle401(res)) return { ok: false, data: null }
    return { ok: res.ok, data: await res.json() }
  } catch (e) {
    if (callerSignal?.aborted) return { ok: false, data: null }
    if (e instanceof DOMException && e.name === 'AbortError') return { ok: false, data: { message: '请求超时' } as T }
    return { ok: false, data: { message: errorMessage(e) } as T }
  } finally { clear() }
}

async function postPlain<T = unknown>(path: string, data: unknown): Promise<ApiResult<T>> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { ok: res.ok, data: await res.json() }
}

export async function login(password: string): Promise<ApiResult<ApiMessageData>> { return postPlain<ApiMessageData>('/login', { password }) }
export async function verifyAdmin(password: string): Promise<ApiResult<ApiMessageData | null>> { return post<ApiMessageData>('/admin/verify', { password }) }
export async function changePassword(type: string, oldPassword: string, newPassword: string): Promise<ApiResult<ApiMessageData | null>> { return put<ApiMessageData>('/auth/password', { type, oldPassword, newPassword }, true) }
export async function resetPassword(resetToken: string): Promise<ApiResult<ApiMessageData>> { return postPlain<ApiMessageData>('/auth/reset-password', { resetToken }) }
export { setAdminToken, getAdminToken, clearAdminToken, clearDashboardSession }
export async function fetchStatus(): Promise<ApiResult<StatusData | null>> { return get<StatusData>('/status') }
export async function fetchPersonas() { return get('/personas') }
export async function fetchPersonaDetail(name: string) { return get('/personas?name=' + encodeURIComponent(name)) }
export async function fetchPersonaDiagnostics() { return get('/persona-diagnostics') }
export async function fetchModes() { return get('/modes') }
export async function fetchWhitelist(): Promise<ApiResult<WhitelistMap | null>> { return get<WhitelistMap>('/whitelist', true) }
// 读取当前机器人所在群的名称，沿用控制台的管理员鉴权。
export async function fetchGroupNames(signal?: AbortSignal): Promise<ApiResult<GroupNamesResponse | null>> { return get<GroupNamesResponse>('/groups', true, 10000, signal) }

// 首次加入群时读取名称，此后只使用服务端保存的备注。
export async function importGroupNames(groupIds: string[]): Promise<ApiResult<GroupNamesResponse | null>> { return post<GroupNamesResponse>('/groups/import', { groupIds }, true) }

// 保存控制台群名，不修改 QQ 群的实际名称。
export async function saveGroupName(groupId: string, name: string): Promise<ApiResult<GroupNamesResponse | null>> { return put<GroupNamesResponse>('/groups', { groupId, name }, true) }
export async function updateWhitelist(type: string, data: unknown): Promise<ApiResult<ApiMessageData | null>> { return put<ApiMessageData>('/whitelist', { type, data }, true) }
export async function fetchFeatures(): Promise<ApiResult<FeatureInfo[] | null>> { return get<FeatureInfo[]>('/features') }
export async function fetchCommands(): Promise<ApiResult<CommandGroup[] | null>> { return get<CommandGroup[]>('/commands') }
export async function fetchLoreList() { return get('/lore-list') }
export async function createPersona(data: unknown) { return post('/personas', data, true) }
export async function updatePersona(data: unknown) { return put('/personas', data, true) }
export async function deletePersona(name: string) { return del('/personas', { name }, true) }
export async function fetchLores() { return get('/lores') }
export async function createLore(data: unknown) { return post('/lores', data, true) }
export async function updateLore(data: unknown) { return put('/lores', data, true) }
export async function deleteLore(name: string) { return del('/lores', { name }, true) }
export async function botStatus() { return get('/bot/status') }
export async function startBot() { return post('/bot/start', {}, true) }
export async function stopBot() { return post('/bot/stop', {}, true) }
export async function fetchMaintenance() { return get('/maintenance') }
export async function setMaintenance(enabled: boolean) { return put('/maintenance', { enabled }, true) }
export async function fetchQQToken() { return get('/qq/token', true) }
export async function fetchSSHInfo() { return get('/qq/ssh-info', true) }
export async function fetchSelfId() { return get('/qq/selfid') }
export async function updateSelfId(selfId: string) { return put('/qq/selfid', { selfId }, true) }
export async function fetchDeployConfig() { return get('/deploy/config', true) }
export async function updateDeployConfig(data: unknown) { return put('/deploy/config', data, true) }
export async function previewDeploy(data: unknown) { return post('/deploy/preview', data, true, 10 * 60 * 1000) }
export async function runDeploy(data: unknown) { return post('/deploy/run', data, true, 4 * 60 * 1000) }
export async function getDeployProgress(taskId: string) { return get('/deploy/progress/' + encodeURIComponent(taskId), true) }
export async function uploadDeploy(name: string, data: string) { return post('/deploy/upload', { name, data }, true) }
export async function deployLocal(data: unknown) { return post('/deploy/local', data, true) }
export async function checkLocalEnv() { return get('/env/check', true) }
export async function downloadNapcat(url: string) { return post('/deploy/napcat-download', { url }, true, 180000) }
export async function downloadNapcatWindows(installDir: string) { return post('/deploy/napcat-windows-download', { installDir }, true, 240000) }
export async function installPortableNode() { return post('/deploy/node-windows-install', {}, true, 240000) }
export async function startNpmInstall() { return post('/deploy/npm-install', {}, true, 60000) }
export async function repairNpmProxyAndInstall() { return post('/deploy/npm-repair-and-install', {}, true, 60000) }
export async function npmInstallStatus(signal?: AbortSignal) { return get('/deploy/npm-install-status', false, 10000, signal) }
export async function startNapcat() { return post('/deploy/napcat-start', {}, true, 10000) }
export async function napcatDeployStatus(signal?: AbortSignal) { return get('/deploy/napcat-status', false, 10000, signal) }
// 等待 NapCat 与原本运行的机器人恢复连接，避免取消仍在进行的恢复。
export async function restartNapcat() { return post('/napcat/restart', {}, true, 120000) }

// Linux QQ 协议服务与 SnowLuma 登录入口。
export async function fetchProtocolStatus() { return get('/protocol/status') }
export async function changeProtocol(provider: 'napcat' | 'sl') { return post('/protocol/switch', { provider }, true, 150000) }
export async function fetchSlLogin() { return get('/protocol/sl/login', true, 30000) }
export async function acceptSlConsent(version: string) { return post('/protocol/sl/consent', { version }, true, 30000) }
export async function connectSl() { return post('/protocol/sl/connect', {}, true, 90000) }
export async function openSlDesktop() { return post('/protocol/sl/desktop', {}, true, 30000) }
// 读取管理员可见的群聊与全局私聊总开关。
export async function fetchParticipation(): Promise<ApiResult<ParticipationResponse | null>> { return get<ParticipationResponse>('/participation', true) }
// 保存一个开关，首次开启群时由后端原子初始化功能默认值。
export async function saveParticipation(change: ParticipationChange): Promise<ApiResult<ParticipationResponse | null>> { return put<ParticipationResponse>('/participation', change, true) }
// 添加一个默认关闭的管理群，保留已有群配置。
export async function addManagedGroup(groupId: string): Promise<ApiResult<ParticipationResponse | null>> { return post<ParticipationResponse>('/groups', { groupId }, true) }
// 从管理列表移除群并停止该群参与。
export async function deleteManagedGroup(groupId: string): Promise<ApiResult<ParticipationResponse | null>> { return del<ParticipationResponse>('/groups', { groupId }, true) }
// 读取指定群的全部可编辑功能和可选人格。
export async function fetchGroupSettings(groupId: string): Promise<ApiResult<GroupSettingsResponse | null>> { return get<GroupSettingsResponse>('/groups/detail?groupId=' + encodeURIComponent(groupId), true) }
// 以单次事务保存群详情，避免多项配置只保存一部分。
export async function saveGroupSettings(settings: GroupSettings): Promise<ApiResult<GroupSettingsResponse | null>> { return put<GroupSettingsResponse>('/groups/detail', settings, true) }
export async function startKoishiLocal() { return post('/deploy/koishi-start', {}, true, 10000) }
export async function koishiDeployStatus(signal?: AbortSignal) { return get('/deploy/koishi-status', false, 10000, signal) }
export async function localReadyCheck() { return get('/deploy/local-ready-check') }
export async function previewLocalConfigDelete() { return get('/deploy/local-config-preview', true) }
export async function deleteLocalConfig() { return post('/deploy/local-config-delete', {}, true) }
export async function previewLocalUninstall() { return get('/deploy/local-uninstall-preview', true, 60000) }
export async function confirmLocalUninstall(options?: JsonObject) { return post('/deploy/local-uninstall', { ...(options || {}), confirm: true }, true, 180000) }
export async function localBotStatus() { return get('/bot/local-status') }
export async function localBotStop() { return post('/bot/local-stop', {}, true) }
// 启动请求的取消只终止客户端等待，服务端构建自行结算。
export async function rebuildFrontend(signal?: AbortSignal) { return post('/frontend/rebuild', {}, true, 10000, signal) }

// 读取状态时沿用接口超时，轮次结束可取消在途读取。
export async function rebuildFrontendStatus(signal?: AbortSignal) { return get('/frontend/rebuild-status', false, 10000, signal) }
export async function fetchAdminIds() { return get('/admin-ids', true) }
export async function updateAdminIds(ids: string[]) { return put('/admin-ids', { ids }, true) }
export async function fetchThrottle() { return get('/throttle') }
export async function saveThrottle(data: unknown) { return put('/throttle', data, true) }
export async function fetchLogs(params: Record<string, unknown> = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) query.set(key, value.join(','))
    else query.set(key, String(value))
  }
  const suffix = query.toString() ? '?' + query.toString() : ''
  return get('/bot/activity' + suffix, true)
}
export async function fetchLoggingConfig() { return get('/logging') }
export async function saveLoggingConfig(data: unknown) { return put('/logging', data, true) }
export async function fetchAgentConfig() { return get('/agent/config', true) }
export async function saveAgentConfig(data: unknown) { return put('/agent/config', data, true) }
export async function fetchAgentPersonas() { return get('/agent/personas', true) }
export async function saveAgentPersona(data: unknown) { return put('/agent/persona', data, true) }
export async function sendAgentMessage(message: string, history: unknown[] = []) { return post('/agent/chat', { message, history }, true, 10000) }
export async function confirmAgentTool(pendingId = '') { return post('/agent/confirm', { pendingId }, true, 10000) }
export async function fetchAgentTask(taskId: string) { return get('/agent/tasks/' + encodeURIComponent(taskId), true) }
export async function rejectAgentTool(pendingId = '') { return post('/agent/reject', { pendingId }, true) }
export async function fetchPendingAgentTools() { return get('/tools/pending', true) }
export async function fetchAgentSessions() { return get('/agent/sessions', true) }
export async function fetchAgentSession(id: string) { return get('/agent/sessions/' + encodeURIComponent(id), true) }
export async function fetchResourceStatus(signal?: AbortSignal) { return get('/resource/status', false, 10000, signal) }
export async function fetchResourceMode() { return get('/resource/mode') }
export async function setResourceMode(serverMode: string) { return post('/resource/mode', { serverMode }, true) }
export async function fetchResourceMemoryHistory(range = '5m', signal?: AbortSignal) { return get('/resource/memory-history?range=' + encodeURIComponent(range), false, 20000, signal) }
// 按选中的状态查询任务，避免历史记录占满进行中或失败列表。
export async function fetchResourceTasks(status = '', signal?: AbortSignal) { return get('/resource/tasks' + (status ? '?status=' + encodeURIComponent(status) : ''), false, 10000, signal) }
// 单日报诊断仅在展开详情时读取，使用既有管理员验证头。
export async function fetchReportAnalysis(taskId: string, signal?: AbortSignal) { return get('/resource/report-analysis?taskId=' + encodeURIComponent(taskId), true, 10000, signal) }
// Reads one stable page of resource diagnostic summaries.
export async function fetchResourceDiagnostics(options: { group?: string; reason?: string; cursor?: string } = {}, signal?: AbortSignal) {
  const params = new URLSearchParams()
  if (options.group) params.set('group', options.group)
  if (options.reason) params.set('reason', options.reason)
  if (options.cursor) params.set('cursor', options.cursor)
  const query = params.toString()
  return get('/resource/diagnostics' + (query ? `?${query}` : ''), false, 10000, signal)
}
// Reads one diagnostic detail only after the administrator expands its record.
export async function fetchResourceDiagnosticDetail(recordId: string, signal?: AbortSignal) {
  return get('/resource/diagnostics/detail?id=' + encodeURIComponent(recordId), false, 10000, signal)
}
export async function fetchResourceEvents(signal?: AbortSignal) { return get('/resource/events', false, 10000, signal) }
export async function fetchResourceWorkers() { return get('/resource/workers') }
export async function fetchResourceMedia() { return get('/resource/media') }
export async function fetchResourcePrecompute() { return get('/resource/precompute') }
export async function cancelResourceTask(taskId: string, reason = 'dashboard cancel') { return post('/resource/cancel', { taskId, reason }, true) }
export async function setResourceMaintenance(enabled: boolean, message = '优化中，别急') { return post('/resource/maintenance', { enabled, message }, true) }
export async function fetchGalleryImages() { return get('/gallery') }
export async function uploadGalleryImage(data: unknown) { return post('/gallery', data, true, 60000) }
export async function deleteGalleryImage(idOrIds: string | string[]) { return del('/gallery', Array.isArray(idOrIds) ? { ids: idOrIds } : { id: idOrIds }, true) }
export async function updateGalleryImageStyle(id: string, foilStyle: string | null) { return put('/gallery/style', { id, foilStyle }, true) }

// 读取统一 AI 供应商目录和四能力脱敏配置。
export async function fetchAiModelApiConfig(): Promise<ApiResult<AiModelApiConfigResponse | null>> {
  return get<AiModelApiConfigResponse>('/ai-model-api/config', true)
}

// 独立保存内置供应商 Key，获取参考模型池和脱敏配置。
export async function saveAiProviderKey(providerId: string, apiKey: string): Promise<ApiResult<AiModelApiConfigResponse | null>> {
  return put<AiModelApiConfigResponse>('/ai-model-api/key', { providerId, apiKey }, true)
}

// 用本次输入 Key 发现模型并原子保存供应商定义、Key 槽位与模型池。
export async function discoverAiProviderModels(providerId: string, apiKey: string, payload: { capability?: AiCapability; detectCapabilities?: boolean; name?: string; note?: string; baseURL?: string } = { capability: 'text' }): Promise<ApiResult<AiDiscoveryResponse | null>> {
  if (providerId !== 'custom-new' && !providerId.startsWith('custom-') && payload.capability === 'text' && !payload.name && !payload.note && !payload.baseURL) return post<AiDiscoveryResponse>('/ai-model-api/discover', { providerId, apiKey }, true, 20000)
  return post<AiDiscoveryResponse>('/ai-model-api/discover', { providerId, apiKey, ...payload }, true, 20000)
}

// 只将供应商与模型标识交给服务端，复用已保存 Key 检测全部四项能力。
export async function detectAiModelCapabilities(providerId: string, modelId: string): Promise<ApiResult<AiPriorityResponse | null>> {
  // 四项能力最多两项并发，每项等待 30 秒，为两轮请求及配置保存预留时间。
  return post<AiPriorityResponse>('/ai-model-api/detect', { providerId, modelId }, true, 90000)
}

// 移除本系统保存的 Key、模型池和优先级引用，保留历史用量。
export async function deleteAiProviderKey(providerId: string): Promise<ApiResult<AiModelApiConfigResponse | null>> {
  return del<AiModelApiConfigResponse>('/ai-model-api/key', { providerId }, true)
}

// 独立保存一个能力的有序优先级。
export async function saveAiCapabilityPriority(capability: AiCapability, steps: AiPriorityStep[]): Promise<ApiResult<AiPriorityResponse | null>> {
  return put<AiPriorityResponse>('/ai-model-api/priority', { capability, steps }, true)
}

// 只读取当前所选能力的独立用量。
export async function fetchAiCapabilityUsage(capability: AiCapability, range?: { startDate: string; endDate: string }): Promise<ApiResult<CapabilityUsageResponse | null>> {
  const query = new URLSearchParams({ capability })
  if (range) {
    query.set('startDate', range.startDate)
    query.set('endDate', range.endDate)
  }
  return get<CapabilityUsageResponse>('/keys/usage?' + query, true)
}

export async function fetchTtsVoices() { return get('/agent/tts/voices', true) }
export async function ttsPreview(text: string, voice: string, style: string, personaName = '', voiceAssetId = '') { return post('/agent/tts/preview', { text, voice, style, personaName, voiceAssetId }, true, 30000) }
export async function ttsClone(personaName: string, audioBase64: string, mimeType: string, meta: JsonObject = {}) { return post('/agent/tts/clone', { personaName, audioBase64, mimeType, ...meta }, true, 60000) }
export async function updateTtsClone(id: string, data: JsonObject) { return post('/agent/tts/clone/rename', { id, ...data }, true) }
export async function deleteTtsClone(id: string, force = false) { return post('/agent/tts/clone/delete', { id, force }, true) }
export async function savePersonaVoice(personaName: string, voiceId: string, voiceStyle: string, voiceAssetId = '') { return put('/agent/persona/voice', { personaName, voiceId, voiceStyle, voiceAssetId }, true) }
