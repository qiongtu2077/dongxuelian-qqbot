import type {
  AdminVerifyResponse,
  AgentChatResponse,
  AgentConfigResponse,
  AgentCronsResponse,
  AgentEnvResponse,
  AgentFilePreviewResponse,
  AgentFilesResponse,
  AgentFileUploadPayload,
  AgentFileUploadResponse,
  AgentPersonasResponse,
  AgentPlanResponse,
  AgentPlansResponse,
  AgentPushLogResponse,
  AgentQueueResponse,
  AgentSessionsResponse,
  AgentShellGuardResponse,
  AgentStatsResponse,
  ApiEnvelope,
  ApiResult,
  ChatHistoryItem,
  SaveAgentConfigPayload,
  SaveAgentConfigResponse,
  AgentCronDraft,
  AgentPersonaConfig,
  SaveAgentPersonaResponse,
  PendingToolsResponse,
} from './types'

const BASE = '/dashboard/api'
const SERVER_TOKEN_KEY = 'dashboard_server_token'
const LEGACY_ADMIN_TOKEN_KEY = 'dashboard_admin_token'
const ACCESS_TOKEN_KEY = 'dashboard_token'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function getErrorMessage(error: unknown, fallback = '请求失败') {
  if (error instanceof Error && error.message) return error.message
  if (isRecord(error) && typeof error.message === 'string') return error.message
  return fallback
}

function getAdminToken() {
  try {
    const raw = localStorage.getItem(SERVER_TOKEN_KEY) || localStorage.getItem(LEGACY_ADMIN_TOKEN_KEY)
    if (!raw) return ''
    const parsed = JSON.parse(raw)
    if (Date.now() > parsed.expires) return ''
    return parsed.token || ''
  } catch {
    return ''
  }
}

function headers(admin = true) {
  const result: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = localStorage.getItem(ACCESS_TOKEN_KEY)
  if (token) result.Authorization = 'Bearer ' + token
  const adminToken = admin ? getAdminToken() : ''
  if (adminToken) result['X-Admin-Token'] = adminToken
  return result
}

async function request<T extends ApiEnvelope>(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<ApiResult<T>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + path, { ...init, headers: { ...headers(true), ...(init.headers || {}) }, signal: ctrl.signal })
    const data: unknown = await res.json().catch(() => null)
    const envelope = isRecord(data) ? data : null
    const ok = envelope?.ok
    const code = typeof envelope?.code === 'string' ? envelope.code : undefined
    const message = typeof envelope?.message === 'string' ? envelope.message : undefined
    return { ok: res.ok && ok !== false, data: data as T | null, code, message }
  } catch (error: unknown) {
    const name = isRecord(error) && typeof error.name === 'string' ? error.name : ''
    return { ok: false, data: null, message: name === 'AbortError' ? '请求超时' : getErrorMessage(error) }
  } finally {
    clearTimeout(timer)
  }
}

export function setAdminToken(token: string) {
  localStorage.setItem(SERVER_TOKEN_KEY, JSON.stringify({ token, expires: Date.now() + 43200000 }))
  localStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY)
}

export function setAccessToken(token = '') {
  if (token) localStorage.setItem(ACCESS_TOKEN_KEY, token)
}

export async function verifyAdmin(password: string) {
  const res = await fetch(BASE + '/admin/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  return res.json() as Promise<AdminVerifyResponse>
}

export const api = {
  getConfig: () => request<AgentConfigResponse>('/agent/config'),
  saveConfig: (payload: SaveAgentConfigPayload) => request<SaveAgentConfigResponse>('/agent/config', { method: 'PUT', body: JSON.stringify(payload) }),
  personas: () => request<AgentPersonasResponse>('/agent/personas'),
  savePersona: (payload: AgentPersonaConfig) => request<SaveAgentPersonaResponse>('/agent/persona', { method: 'PUT', body: JSON.stringify(payload) }),
  chat: (message: string, history: ChatHistoryItem[], enableThinking = false, agentMode = true) => request<AgentChatResponse>('/agent/chat', { method: 'POST', body: JSON.stringify({ message, history, enableThinking, agentMode }) }, 90000),
  pending: () => request<PendingToolsResponse>('/tools/pending'),
  confirm: (pendingId: string) => request<AgentChatResponse>('/agent/confirm', { method: 'POST', body: JSON.stringify({ pendingId }) }, 90000),
  reject: (pendingId: string) => request<ApiEnvelope>('/agent/reject', { method: 'POST', body: JSON.stringify({ pendingId }) }),
  sessions: () => request<AgentSessionsResponse>('/agent/sessions'),
  session: (id: string) => request<ApiEnvelope>('/agent/sessions/' + encodeURIComponent(id)),
  stats: () => request<AgentStatsResponse>('/agent/stats'),
  queue: () => request<AgentQueueResponse>('/agent/queue'),
  files: (root = '', q = '') => request<AgentFilesResponse>('/agent/files?root=' + encodeURIComponent(root) + '&q=' + encodeURIComponent(q)),
  filePreview: (path: string) => request<AgentFilePreviewResponse>('/agent/file?path=' + encodeURIComponent(path)),
  fileDownload: async (filePath: string) => {
    const res = await fetch(BASE + '/agent/file/download?path=' + encodeURIComponent(filePath), { headers: headers(true) })
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => null)
      const message = isRecord(data) && typeof data.message === 'string' ? data.message : '下载失败'
      throw new Error(message)
    }
    return res.blob()
  },
  fileUpload: (payload: AgentFileUploadPayload) => request<AgentFileUploadResponse>('/agent/file/upload', { method: 'POST', body: JSON.stringify(payload) }, 90000),
  env: () => request<AgentEnvResponse>('/agent/env'),
  shellGuard: () => request<AgentShellGuardResponse>('/agent/shell-guard'),
  plans: () => request<AgentPlansResponse>('/agent/plans'),
  plan: (id: string) => request<AgentPlanResponse>('/agent/plans/' + encodeURIComponent(id)),
  createPlan: (goal: string) => request<AgentPlanResponse>('/agent/plans', { method: 'POST', body: JSON.stringify({ goal }) }, 90000),
  resumePlan: (id: string) => request<AgentPlanResponse>('/agent/plans/' + encodeURIComponent(id) + '/resume', { method: 'POST', body: '{}' }, 90000),
  abandonPlan: (id: string, reason = 'Agent Console 放弃计划') => request<ApiEnvelope>('/agent/plans/' + encodeURIComponent(id) + '/abandon', { method: 'POST', body: JSON.stringify({ reason }) }),
  crons: () => request<AgentCronsResponse>('/agent/crons'),
  createCron: (cron: AgentCronDraft) => request<ApiEnvelope>('/agent/crons', { method: 'POST', body: JSON.stringify(cron) }),
  runCron: (id: string) => request<ApiEnvelope>('/agent/crons/' + encodeURIComponent(id) + '/run', { method: 'POST', body: '{}' }, 90000),
  deleteCron: (id: string) => request<ApiEnvelope>('/agent/crons/' + encodeURIComponent(id), { method: 'DELETE' }),
  pushLog: () => request<AgentPushLogResponse>('/agent/push-log'),
}
