const BASE = '/dashboard/api'
const SERVER_TOKEN_KEY = 'dashboard_server_token'
const LEGACY_ADMIN_TOKEN_KEY = 'dashboard_admin_token'

import type {
  ApiMessageData,
  ApiResult,
  CommandGroup,
  CustomProvider,
  DashboardConfig,
  FallbackData,
  FeatureInfo,
  JsonObject,
  ProviderInfo,
  StatusData,
  WhitelistMap,
} from './types'
import { errorMessage } from './types'

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
    localStorage.removeItem('dashboard_token')
    // 抛出自定义事件，让 App.vue 去优雅处理退出，而不是暴力刷新
    window.dispatchEvent(new Event('auth-expired')) 
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

function withTimeout(ms = 10000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) }
}

async function get<T = unknown>(path: string, admin = false, timeoutMs = 10000): Promise<ApiResult<T | null>> {
  const { signal, clear } = withTimeout(timeoutMs)
  try {
    const res = await fetch(BASE + path, { headers: headers(admin), signal })
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

async function post<T = unknown>(path: string, data: unknown, admin = false, timeoutMs = 10000): Promise<ApiResult<T | null>> {
  const { signal, clear } = withTimeout(timeoutMs)
  try {
    const res = await fetch(BASE + path, { method: 'POST', headers: headers(admin), body: JSON.stringify(data), signal })
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
export { setAdminToken, getAdminToken, clearAdminToken }
export async function fetchStatus(): Promise<ApiResult<StatusData | null>> { return get<StatusData>('/status') }
export async function fetchProviders(): Promise<ApiResult<Record<string, ProviderInfo> | null>> { return get<Record<string, ProviderInfo>>('/providers') }
export async function fetchConfig(): Promise<ApiResult<DashboardConfig | null>> { return get<DashboardConfig>('/config') }
export async function updateConfig(data: unknown): Promise<ApiResult<ApiMessageData | null>> { return put<ApiMessageData>('/config', data, true) }
export async function fetchPersonas() { return get('/personas') }
export async function fetchPersonaDetail(name: string) { return get('/personas?name=' + encodeURIComponent(name)) }
export async function fetchPersonaDiagnostics() { return get('/persona-diagnostics') }
export async function fetchModes() { return get('/modes') }
export async function fetchWhitelist(): Promise<ApiResult<WhitelistMap | null>> { return get<WhitelistMap>('/whitelist', true) }
export async function updateWhitelist(type: string, data: unknown): Promise<ApiResult<ApiMessageData | null>> { return put<ApiMessageData>('/whitelist', { type, data }, true) }
export async function fetchKeys() { return get('/keys', true) }
export async function updateKey(file: string, value: string) { return put('/keys', { file, value }, true) }
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
export async function checkDeployUpdate() { return get('/deploy/check-update') }
export async function runDeploy(data: unknown) { return post('/deploy/run', data, true) }
export async function getDeployProgress(taskId: string) { return get('/deploy/progress/' + encodeURIComponent(taskId)) }
export async function confirmDeploy() { return post('/deploy/confirm', {}, true) }
export async function uploadDeploy(name: string, data: string) { return post('/deploy/upload', { name, data }, true) }
export async function deployLocal(data: unknown) { return post('/deploy/local', data, true) }
export async function checkLocalEnv() { return get('/env/check', true) }
export async function downloadNapcat(url: string) { return post('/deploy/napcat-download', { url }, true, 180000) }
export async function downloadNapcatWindows(installDir: string) { return post('/deploy/napcat-windows-download', { installDir }, true, 240000) }
export async function installPortableNode() { return post('/deploy/node-windows-install', {}, true, 240000) }
export async function startNpmInstall() { return post('/deploy/npm-install', {}, true, 60000) }
export async function repairNpmProxyAndInstall() { return post('/deploy/npm-repair-and-install', {}, true, 60000) }
export async function npmInstallStatus() { return get('/deploy/npm-install-status') }
export async function startNapcat() { return post('/deploy/napcat-start', {}, true, 10000) }
export async function napcatDeployStatus() { return get('/deploy/napcat-status') }
export async function restartNapcat() { return post('/napcat/restart', {}, true, 15000) }
export async function startKoishiLocal() { return post('/deploy/koishi-start', {}, true, 10000) }
export async function koishiDeployStatus() { return get('/deploy/koishi-status') }
export async function localReadyCheck() { return get('/deploy/local-ready-check') }
export async function previewLocalConfigDelete() { return get('/deploy/local-config-preview', true) }
export async function deleteLocalConfig() { return post('/deploy/local-config-delete', {}, true) }
export async function previewLocalUninstall() { return get('/deploy/local-uninstall-preview', true, 60000) }
export async function confirmLocalUninstall(options?: JsonObject) { return post('/deploy/local-uninstall', { ...(options || {}), confirm: true }, true, 180000) }
export async function localBotStatus() { return get('/bot/local-status') }
export async function localBotStop() { return post('/bot/local-stop', {}, true) }
export async function rebuildFrontend() { return post('/frontend/rebuild', {}, true) }
export async function rebuildFrontendStatus() { return get('/frontend/rebuild-status') }
export async function fetchFallbackChains(): Promise<ApiResult<FallbackData | null>> { return get<FallbackData>('/fallback', true) }
export async function saveFallbackChains(chains: unknown): Promise<ApiResult<ApiMessageData | null>> { return put<ApiMessageData>('/fallback', { chains }, true) }
export async function fetchCustomProviders(): Promise<ApiResult<CustomProvider[] | null>> { return get<CustomProvider[]>('/providers/custom', true) }
export async function saveCustomProviders(data: unknown): Promise<ApiResult<ApiMessageData | null>> { return put<ApiMessageData>('/providers/custom', data, true) }
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
export async function fetchResourceStatus() { return get('/resource/status') }
export async function fetchResourceMode() { return get('/resource/mode') }
export async function setResourceMode(serverMode: string) { return post('/resource/mode', { serverMode }, true) }
export async function fetchResourceMemoryHistory(range = '5m') { return get('/resource/memory-history?range=' + encodeURIComponent(range), false, 20000) }
export async function fetchResourceTasks() { return get('/resource/tasks') }
export async function fetchResourceEvents() { return get('/resource/events') }
export async function fetchResourceWorkers() { return get('/resource/workers') }
export async function fetchResourceMedia() { return get('/resource/media') }
export async function fetchResourcePrecompute() { return get('/resource/precompute') }
export async function cancelResourceTask(taskId: string, reason = 'dashboard cancel') { return post('/resource/cancel', { taskId, reason }, true) }
export async function reclaimResourceStale(staleMs = 30000) { return post('/resource/reclaim-stale', { staleMs }, true) }
export async function setResourceMaintenance(enabled: boolean, message = '优化中，别急') { return post('/resource/maintenance', { enabled, message }, true) }
export async function fetchGalleryImages() { return get('/gallery') }
export async function uploadGalleryImage(data: unknown) { return post('/gallery', data, true, 60000) }
export async function deleteGalleryImage(idOrIds: string | string[]) { return del('/gallery', Array.isArray(idOrIds) ? { ids: idOrIds } : { id: idOrIds }, true) }
export async function updateGalleryImageStyle(id: string, foilStyle: string | null) { return put('/gallery/style', { id, foilStyle }, true) }

export async function fetchKeysUsage() { return get('/keys/usage', true) }

export async function fetchTtsVoices() { return get('/agent/tts/voices', true) }
export async function ttsPreview(text: string, voice: string, style: string, personaName = '', voiceAssetId = '') { return post('/agent/tts/preview', { text, voice, style, personaName, voiceAssetId }, true, 30000) }
export async function ttsClone(personaName: string, audioBase64: string, mimeType: string, meta: JsonObject = {}) { return post('/agent/tts/clone', { personaName, audioBase64, mimeType, ...meta }, true, 60000) }
export async function updateTtsClone(id: string, data: JsonObject) { return post('/agent/tts/clone/rename', { id, ...data }, true) }
export async function deleteTtsClone(id: string, force = false) { return post('/agent/tts/clone/delete', { id, force }, true) }
export async function savePersonaVoice(personaName: string, voiceId: string, voiceStyle: string, voiceAssetId = '') { return put('/agent/persona/voice', { personaName, voiceId, voiceStyle, voiceAssetId }, true) }
