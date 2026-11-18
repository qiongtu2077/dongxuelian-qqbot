import type {
  AdminVerifyResponse,
  AgentChatResponse,
  AgentTaskResponse,
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
import { followAgentTask } from './tasks'

// --- Authenticated transport ---

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

/** Identifies the effective session for in-flight reads without exposing credentials in the UI. */
export function getAgentReadSessionKey() {
  return JSON.stringify([localStorage.getItem(ACCESS_TOKEN_KEY), getAdminToken()])
}

function headers(admin = true) {
  const result: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = localStorage.getItem(ACCESS_TOKEN_KEY)
  if (token) result.Authorization = 'Bearer ' + token
  const adminToken = admin ? getAdminToken() : ''
  if (adminToken) result['X-Admin-Token'] = adminToken
  return result
}

/** Sends authenticated JSON with a request timeout and optional caller cancellation. */
async function request<T extends ApiEnvelope>(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<ApiResult<T>> {
  const ctrl = new AbortController()
  const cancel = () => ctrl.abort()
  if (init.signal?.aborted) cancel()
  else init.signal?.addEventListener('abort', cancel, { once: true })
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
    return { ok: false, data: null, code: init.signal?.aborted ? 'ABORTED' : undefined, message: init.signal?.aborted ? '请求已取消' : name === 'AbortError' ? '请求超时' : getErrorMessage(error) }
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', cancel)
  }
}

// --- Login credentials ---

export function setAdminToken(token: string) {
  localStorage.setItem(SERVER_TOKEN_KEY, JSON.stringify({ token, expires: Date.now() + 43200000 }))
  localStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY)
}

export function setAccessToken(token = '') {
  if (token) localStorage.setItem(ACCESS_TOKEN_KEY, token)
}

/** Verifies administrator access using the current Dashboard login token. */
export async function verifyAdmin(password: string) {
  const res = await fetch(BASE + '/admin/verify', {
    method: 'POST',
    headers: headers(false),
    body: JSON.stringify({ password }),
  })
  return res.json() as Promise<AdminVerifyResponse>
}

// --- Agent endpoints ---

/** Reads the existing task-status endpoint using the same authenticated transport. */
const readAgentTask = (taskId: string, signal: AbortSignal) => request<AgentTaskResponse>('/agent/tasks/' + encodeURIComponent(taskId), { signal })

export const api = {
  getConfig: (signal?: AbortSignal) => request<AgentConfigResponse>('/agent/config', { signal }),
  saveConfig: (payload: SaveAgentConfigPayload) => request<SaveAgentConfigResponse>('/agent/config', { method: 'PUT', body: JSON.stringify(payload) }),
  personas: (signal?: AbortSignal) => request<AgentPersonasResponse>('/agent/personas', { signal }),
  savePersona: (payload: AgentPersonaConfig) => request<SaveAgentPersonaResponse>('/agent/persona', { method: 'PUT', body: JSON.stringify(payload) }),
  chat: async (message: string, history: ChatHistoryItem[], enableThinking = false, agentMode = true, signal?: AbortSignal, images?: string[]) => followAgentTask(await request<AgentChatResponse>('/agent/chat', { method: 'POST', body: JSON.stringify({ message, history, enableThinking, agentMode, images }), signal }, 90000), readAgentTask, { signal }),
  pending: (signal?: AbortSignal) => request<PendingToolsResponse>('/tools/pending', { signal }),
  confirm: async (pendingId: string, signal?: AbortSignal) => followAgentTask(await request<AgentChatResponse>('/agent/confirm', { method: 'POST', body: JSON.stringify({ pendingId }), signal }, 90000), readAgentTask, { signal }),
  reject: (pendingId: string) => request<ApiEnvelope>('/agent/reject', { method: 'POST', body: JSON.stringify({ pendingId }) }),
  sessions: (signal?: AbortSignal) => request<AgentSessionsResponse>('/agent/sessions', { signal }),
  session: (id: string) => request<ApiEnvelope>('/agent/sessions/' + encodeURIComponent(id)),
  stats: (signal?: AbortSignal) => request<AgentStatsResponse>('/agent/stats', { signal }),
  queue: (signal?: AbortSignal) => request<AgentQueueResponse>('/agent/queue', { signal }),
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
  env: (signal?: AbortSignal) => request<AgentEnvResponse>('/agent/env', { signal }),
  shellGuard: (signal?: AbortSignal) => request<AgentShellGuardResponse>('/agent/shell-guard', { signal }),
  plans: (signal?: AbortSignal) => request<AgentPlansResponse>('/agent/plans', { signal }),
  plan: (id: string) => request<AgentPlanResponse>('/agent/plans/' + encodeURIComponent(id)),
  createPlan: (goal: string) => request<AgentPlanResponse>('/agent/plans', { method: 'POST', body: JSON.stringify({ goal }) }, 90000),
  resumePlan: (id: string) => request<AgentPlanResponse>('/agent/plans/' + encodeURIComponent(id) + '/resume', { method: 'POST', body: '{}' }, 90000),
  abandonPlan: (id: string, reason = 'Agent Console 放弃计划') => request<ApiEnvelope>('/agent/plans/' + encodeURIComponent(id) + '/abandon', { method: 'POST', body: JSON.stringify({ reason }) }),
  crons: (signal?: AbortSignal) => request<AgentCronsResponse>('/agent/crons', { signal }),
  createCron: (cron: AgentCronDraft) => request<ApiEnvelope>('/agent/crons', { method: 'POST', body: JSON.stringify(cron) }),
  runCron: (id: string) => request<ApiEnvelope>('/agent/crons/' + encodeURIComponent(id) + '/run', { method: 'POST', body: '{}' }, 90000),
  deleteCron: (id: string) => request<ApiEnvelope>('/agent/crons/' + encodeURIComponent(id), { method: 'DELETE' }),
  pushLog: (signal?: AbortSignal) => request<AgentPushLogResponse>('/agent/push-log', { signal }),
}
