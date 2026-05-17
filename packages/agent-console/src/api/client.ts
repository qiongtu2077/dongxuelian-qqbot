const BASE = '/dashboard/api'
const SERVER_TOKEN_KEY = 'dashboard_server_token'
const LEGACY_ADMIN_TOKEN_KEY = 'dashboard_admin_token'
const ACCESS_TOKEN_KEY = 'dashboard_token'

type ApiResult<T> = { ok: boolean; data: T | null; code?: string; message?: string }

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

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<ApiResult<T>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + path, { ...init, headers: { ...headers(true), ...(init.headers || {}) }, signal: ctrl.signal })
    const data = await res.json().catch(() => null)
    return { ok: res.ok && data?.ok !== false, data, code: data?.code, message: data?.message }
  } catch (error: any) {
    return { ok: false, data: null, message: error?.name === 'AbortError' ? '请求超时' : error?.message || '请求失败' }
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
  return res.json()
}

export const api = {
  getConfig: () => request<any>('/agent/config'),
  saveConfig: (payload: any) => request<any>('/agent/config', { method: 'PUT', body: JSON.stringify(payload) }),
  personas: () => request<any>('/agent/personas'),
  savePersona: (payload: any) => request<any>('/agent/persona', { method: 'PUT', body: JSON.stringify(payload) }),
  chat: (message: string, history: any[], enableThinking = false, agentMode = true) => request<any>('/agent/chat', { method: 'POST', body: JSON.stringify({ message, history, enableThinking, agentMode }) }, 90000),
  pending: () => request<any>('/tools/pending'),
  confirm: (pendingId: string) => request<any>('/agent/confirm', { method: 'POST', body: JSON.stringify({ pendingId }) }, 90000),
  reject: (pendingId: string) => request<any>('/agent/reject', { method: 'POST', body: JSON.stringify({ pendingId }) }),
  sessions: () => request<any>('/agent/sessions'),
  session: (id: string) => request<any>('/agent/sessions/' + encodeURIComponent(id)),
  stats: () => request<any>('/agent/stats'),
  queue: () => request<any>('/agent/queue'),
  files: (root = '', q = '') => request<any>('/agent/files?root=' + encodeURIComponent(root) + '&q=' + encodeURIComponent(q)),
  filePreview: (path: string) => request<any>('/agent/file?path=' + encodeURIComponent(path)),
  fileDownload: async (filePath: string) => {
    const res = await fetch(BASE + '/agent/file/download?path=' + encodeURIComponent(filePath), { headers: headers(true) })
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      throw new Error(data?.message || '下载失败')
    }
    return res.blob()
  },
  fileUpload: (payload: any) => request<any>('/agent/file/upload', { method: 'POST', body: JSON.stringify(payload) }, 90000),
  env: () => request<any>('/agent/env'),
  shellGuard: () => request<any>('/agent/shell-guard'),
  plans: () => request<any>('/agent/plans'),
  plan: (id: string) => request<any>('/agent/plans/' + encodeURIComponent(id)),
  createPlan: (goal: string) => request<any>('/agent/plans', { method: 'POST', body: JSON.stringify({ goal }) }, 90000),
  resumePlan: (id: string) => request<any>('/agent/plans/' + encodeURIComponent(id) + '/resume', { method: 'POST', body: '{}' }, 90000),
  abandonPlan: (id: string, reason = 'Agent Console 放弃计划') => request<any>('/agent/plans/' + encodeURIComponent(id) + '/abandon', { method: 'POST', body: JSON.stringify({ reason }) }),
  crons: () => request<any>('/agent/crons'),
  createCron: (cron: any) => request<any>('/agent/crons', { method: 'POST', body: JSON.stringify(cron) }),
  runCron: (id: string) => request<any>('/agent/crons/' + encodeURIComponent(id) + '/run', { method: 'POST', body: '{}' }, 90000),
  deleteCron: (id: string) => request<any>('/agent/crons/' + encodeURIComponent(id), { method: 'DELETE' }),
  pushLog: () => request<any>('/agent/push-log'),
}
