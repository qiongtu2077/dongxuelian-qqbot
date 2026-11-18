import { useEffect, useRef, useState } from 'react'
import { api, getAgentReadSessionKey, getErrorMessage } from './api/client'
import type { AgentConfigResponse, AgentPersonaConfig } from './api/types'

export type TabId = 'chat' | 'inbox' | 'personas' | 'files' | 'skills' | 'tools' | 'plans' | 'cron' | 'stats' | 'runtime' | 'model' | 'env' | 'security'

const readers = {
  config: api.getConfig, personas: api.personas, pending: api.pending, pushLog: api.pushLog,
  plans: api.plans, crons: api.crons, sessions: api.sessions, stats: api.stats, queue: api.queue,
  env: api.env, shellGuard: api.shellGuard,
}
type Dataset = keyof typeof readers
type WorkspaceData = Partial<{ [K in Dataset]: Awaited<ReturnType<typeof readers[K]>>['data'] }>
type AuthState = 'checking' | 'ready' | 'access' | 'admin'
type InFlightRead = { controller: AbortController; promise: Promise<boolean> }

const pageReads: Partial<Record<TabId, Dataset[]>> = {
  chat: ['personas'], personas: ['personas'], inbox: ['pending', 'pushLog'],
  plans: ['plans'], cron: ['crons'], stats: ['sessions', 'stats', 'queue'], env: ['env'], security: ['shellGuard'],
}

// --- 工作台会话与读取 ---

/** Confirms the session through config before loading any page datasets. */
export function useAgentData(tab: TabId) {
  const [data, setData] = useState<WorkspaceData>({})
  const [errors, setErrors] = useState<Partial<Record<Dataset, string>>>({})
  const [loadingKeys, setLoadingKeys] = useState<Dataset[]>([])
  const [auth, setAuth] = useState<AuthState>('checking')
  const permission = useRef<AuthState>('checking')
  const mounted = useRef(false)
  const session = useRef('')
  const epoch = useRef(0)
  const activeTab = useRef(tab)
  const reads = useRef(new Map<Dataset, InFlightRead>())
  const renderedEpoch = epoch.current

  /** Cancels reads and clears prior account data when authorization changes. */
  function clearWorkspace(next: AuthState): void {
    epoch.current++
    for (const entry of reads.current.values()) entry.controller.abort()
    reads.current.clear()
    session.current = getAgentReadSessionKey()
    permission.current = next
    setAuth(next)
    setData({})
    setErrors({})
    setLoadingKeys([])
  }

  /** Shares an identical in-flight read and guards every write by session and request ownership. */
  function read(key: Dataset): Promise<boolean> {
    if (!mounted.current) return Promise.resolve(false)
    const identity = getAgentReadSessionKey()
    if (identity !== session.current) clearWorkspace('checking')
    if (key !== 'config' && permission.current !== 'ready') return read('config').then(() => false)
    const existing = reads.current.get(key)
    if (existing) return existing.promise
    const controller = new AbortController(), generation = epoch.current
    const current = () => mounted.current && generation === epoch.current && reads.current.get(key)?.controller === controller
    setLoadingKeys(previous => [...previous.filter(value => value !== key), key])
    setErrors(previous => ({ ...previous, [key]: '' }))
    const promise = Promise.resolve().then(async () => {
      if (!current()) return false
      try {
        const response = await readers[key](controller.signal)
        if (!current()) return false
        if (identity !== getAgentReadSessionKey()) {
          clearWorkspace('checking')
          void read('config')
          return false
        }
        if (response.ok && response.data) {
          setData(previous => ({ ...previous, [key]: response.data }))
          if (key === 'config') { permission.current = 'ready'; setAuth('ready') }
          return true
        }
        if (response.code === 'AUTH_REQUIRED' || response.code === 'ADMIN_REQUIRED') {
          if (key === 'config') clearWorkspace(response.code === 'AUTH_REQUIRED' ? 'access' : 'admin')
          else void read('config')
        } else {
          setErrors(previous => ({ ...previous, [key]: response.message || response.data?.message || '读取工作台数据失败' }))
        }
        return false
      } catch (error: unknown) {
        if (current()) setErrors(previous => ({ ...previous, [key]: getErrorMessage(error, '读取工作台数据失败') }))
        return false
      }
    }).finally(() => {
      if (!current()) return
      reads.current.delete(key)
      setLoadingKeys(previous => previous.filter(value => value !== key))
    })
    reads.current.set(key, { controller, promise })
    return promise
  }

  /** Invalidates only the datasets affected by a write, retaining displayed data until refreshed. */
  function invalidate(keys: readonly Dataset[]): void {
    for (const key of keys) {
      reads.current.get(key)?.controller.abort()
      reads.current.delete(key)
    }
    setLoadingKeys(previous => previous.filter(value => !keys.includes(value)))
  }

  /** Issues the active page's request group after authorization. */
  function loadPage(page: TabId): void {
    for (const key of pageReads[page] ?? []) void read(key)
  }

  /** Restarts the config probe after authentication changes. */
  function reconnect(): void {
    if (!mounted.current) return
    clearWorkspace('checking')
    void read('config')
  }

  useEffect(() => {
    mounted.current = true
    reconnect()
    const storageChanged = () => { if (session.current !== getAgentReadSessionKey()) reconnect() }
    window.addEventListener('storage', storageChanged)
    return () => {
      mounted.current = false
      for (const entry of reads.current.values()) entry.controller.abort()
      reads.current.clear()
      window.removeEventListener('storage', storageChanged)
    }
  }, [])

  useEffect(() => {
    activeTab.current = tab
    if (auth === 'ready') loadPage(tab)
  }, [tab, auth, renderedEpoch])

  // --- 页面刷新与写入后的失效 ---

  /** Refreshes shared config, then the currently visible page in the same session. */
  async function refresh(): Promise<void> {
    const alreadyReady = permission.current === 'ready'
    const generation = epoch.current
    if (await read('config') && alreadyReady && generation === epoch.current) loadPage(activeTab.current)
  }

  /** Refreshes the named write dependents, deferring nonvisible chat dependents until entry. */
  function refreshAfterWrite(keys: readonly Dataset[], visibleOnly = false): void {
    if (renderedEpoch !== epoch.current || !mounted.current) return
    invalidate(keys)
    const visible = pageReads[activeTab.current] ?? []
    for (const key of keys) if (!visibleOnly || visible.includes(key)) void read(key)
  }

  /** Rechecks authorization after an expired chat request, or invalidates its dependent datasets. */
  function chatSettled(code?: string): void {
    if (renderedEpoch !== epoch.current || !mounted.current) return
    if (code === 'AUTH_REQUIRED' || code === 'ADMIN_REQUIRED') { void read('config'); return }
    refreshAfterWrite(['sessions', 'stats', 'pending', 'queue'], true)
  }

  /** Applies the current session's optimistic config change. */
  function setConfig(config: AgentConfigResponse): void {
    if (renderedEpoch === epoch.current && mounted.current && session.current === getAgentReadSessionKey()) {
      setData(previous => ({ ...previous, config }))
    }
  }

  /** Publishes the saved persona while the server's persona list refreshes. */
  function setPersona(persona: AgentPersonaConfig): void {
    if (renderedEpoch !== epoch.current || !mounted.current || session.current !== getAgentReadSessionKey()) return
    setData(previous => ({ ...previous, personas: { personas: previous.personas?.personas ?? previous.config?.personas ?? [], persona } }))
  }

  const visible = pageReads[tab] ?? []
  return {
    auth, reconnect, refresh, chatSettled, refreshAfterWrite, setConfig, setPersona,
    loading: loadingKeys.some(key => key === 'config' || visible.includes(key)),
    error: errors.config || visible.map(key => errors[key]).find(Boolean) || '',
    config: data.config ?? null, personas: data.personas?.personas ?? data.config?.personas ?? [],
    persona: data.personas ? data.personas.persona ?? null : data.config?.config?.persona ?? null,
    pending: data.pending?.pending ?? [], pushLog: data.pushLog?.log ?? [], plans: data.plans?.plans ?? [],
    crons: data.crons?.crons ?? [], cronHistory: data.crons?.history ?? [], sessions: data.sessions?.sessions ?? [],
    stats: data.stats?.stats ?? null, queue: data.queue?.queue ?? null, env: data.env ?? null, shellGuard: data.shellGuard ?? null,
  }
}

export type AgentData = ReturnType<typeof useAgentData>
