import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, setAccessToken, setAdminToken, verifyAdmin } from './api/client'
import './styles.css'

type TabId = 'chat' | 'inbox' | 'personas' | 'files' | 'skills' | 'tools' | 'plans' | 'cron' | 'stats' | 'runtime' | 'model' | 'env' | 'security'

type RoundRecord = {
  reasoning: string | null
  toolCalls: Array<{ name: string; args: Record<string, any> }>
  toolResults?: Array<{ name: string; result: string; ok: boolean }>
}

type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  pendingId?: string
  id?: string
  pending?: boolean
  rounds?: RoundRecord[]
}

type AgentMode = 'plan' | 'build'

type CompletionType = 'command' | 'file' | 'skill' | null

const tabs: Array<{ id: TabId; label: string; group: string }> = [
  { id: 'chat', label: '聊天', group: '主功能' },
  { id: 'inbox', label: '收件箱', group: '主功能' },
  { id: 'plans', label: '计划', group: '控制' },
  { id: 'cron', label: '定时任务', group: '控制' },
  { id: 'personas', label: '人格', group: '工作区' },
  { id: 'files', label: '文件', group: '工作区' },
  { id: 'skills', label: '技能', group: '工作区' },
  { id: 'tools', label: '工具', group: '工作区' },
  { id: 'stats', label: '智能体统计', group: '工作区' },
  { id: 'runtime', label: '运行配置', group: '设置' },
  { id: 'model', label: '模型', group: '设置' },
  { id: 'env', label: '环境变量', group: '设置' },
  { id: 'security', label: '安全', group: '设置' },
]

function useAgentData() {
  const [loading, setLoading] = useState(false)
  const [config, setConfig] = useState<any>(null)
  const [pending, setPending] = useState<any[]>([])
  const [sessions, setSessions] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [queue, setQueue] = useState<any>(null)
  const [shellGuard, setShellGuard] = useState<any>(null)
  const [plans, setPlans] = useState<any[]>([])
  const [crons, setCrons] = useState<any[]>([])
  const [cronHistory, setCronHistory] = useState<any[]>([])
  const [pushLog, setPushLog] = useState<any[]>([])
  const [env, setEnv] = useState<any>(null)
  const [personas, setPersonas] = useState<any[]>([])
  const [persona, setPersona] = useState<any>(null)
  const [error, setError] = useState('')
  const [adminRequired, setAdminRequired] = useState(false)

  async function refresh() {
    setLoading(true)
    setError('')
    setAdminRequired(false)
    const [cfg, pnd, ses, sta, que, guard, planRes, cronRes, pushRes, envRes, personaRes] = await Promise.all([
      api.getConfig(),
      api.pending(),
      api.sessions(),
      api.stats(),
      api.queue(),
      api.shellGuard(),
      api.plans(),
      api.crons(),
      api.pushLog(),
      api.env(),
      api.personas(),
    ])
    if (cfg.ok) setConfig(cfg.data)
    else if (cfg.code === 'ADMIN_REQUIRED') setAdminRequired(true)
    else setError(cfg.message || cfg.data?.message || '加载 Agent 配置失败')
    if (pnd.ok) setPending(pnd.data?.pending || [])
    if (ses.ok) setSessions(ses.data?.sessions || [])
    if (sta.ok) setStats(sta.data?.stats)
    if (que.ok) setQueue(que.data?.queue)
    if (guard.ok) setShellGuard(guard.data)
    if (planRes.ok) setPlans(planRes.data?.plans || [])
    if (cronRes.ok) {
      setCrons(cronRes.data?.crons || [])
      setCronHistory(cronRes.data?.history || [])
    }
    if (pushRes.ok) setPushLog(pushRes.data?.log || [])
    if (envRes.ok) setEnv(envRes.data)
    if (personaRes.ok) {
      setPersonas(personaRes.data?.personas || [])
      setPersona(personaRes.data?.persona || null)
    } else if (cfg.ok) {
      setPersonas(cfg.data?.personas || [])
      setPersona(cfg.data?.config?.persona || null)
    }
    setLoading(false)
  }

  useEffect(() => { refresh() }, [])
  return { loading, config, setConfig, pending, sessions, stats, queue, shellGuard, plans, crons, cronHistory, pushLog, env, personas, persona, setPersona, error, adminRequired, refresh }
}

function AdminGate({ onVerified }: { onVerified: () => void }) {
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const result = await verifyAdmin(password)
    if (result?.ok && result?.token) {
      setAdminToken(result.token)
      setAccessToken(result.accessToken || '')
      onVerified()
    } else {
      setMessage(result?.message || '管理员验证失败')
    }
  }
  return (
    <main className="gate">
      <section className="gate-panel">
        <div className="brand-mark">莲</div>
        <h1>莲莲 Agent</h1>
        <p>需要管理员权限进入 Agent 工作台。</p>
        <form onSubmit={submit}>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="管理员密码" autoFocus />
          <button type="submit">进入</button>
        </form>
        {message && <span className="form-error">{message}</span>}
      </section>
    </main>
  )
}

function AdminDialog({ onVerified }: { onVerified: () => void }) {
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const result = await verifyAdmin(password)
    if (result?.ok && result?.token) {
      setAdminToken(result.token)
      setAccessToken(result.accessToken || '')
      onVerified()
    } else {
      setMessage(result?.message || '管理员验证失败')
    }
  }
  return (
    <div className="admin-dialog-backdrop" onClick={() => {}} onKeyDown={e => e.key === 'Escape' && onVerified()}>
      <div className="admin-dialog-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="brand-mark">莲</div>
        <h2>管理员密码已过期</h2>
        <p>请重新输入管理员密码以继续操作。</p>
        <form onSubmit={submit}>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="管理员密码" autoFocus />
          <button type="submit">验证</button>
        </form>
        {message && <span className="form-error">{message}</span>}
      </div>
    </div>
  )
}

function Sidebar({ active, setActive, version }: { active: TabId; setActive: (id: TabId) => void; version: string }) {
  const groups = useMemo(() => Array.from(new Set(tabs.map(tab => tab.group))), [])
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">莲</div>
        <div>
          <strong>莲莲 Agent</strong>
          <span>v{version || '1.1.5'}</span>
        </div>
      </div>
      <div className="agent-select">当前智能体人格可在“人格”页切换</div>
      {groups.map(group => (
        <nav key={group} className="nav-group" aria-label={group}>
          <p>{group}</p>
          {tabs.filter(tab => tab.group === group).map(tab => (
            <button key={tab.id} className={active === tab.id ? 'active' : ''} onClick={() => setActive(tab.id)}>
              <span className="nav-dot" />
              {tab.label}
            </button>
          ))}
        </nav>
      ))}
    </aside>
  )
}

function Topbar({ onRefresh, loading }: { onRefresh: () => void; loading: boolean }) {
  return (
    <header className="topbar">
      <div>
        <strong>Agent Console</strong>
        <span>独立控制台</span>
      </div>
      <div className="top-actions">
        <a href="/dashboard/" title="返回 Dashboard">Dashboard</a>
        <button className="secondary" onClick={async () => {
          const r = await api.getConfig()
          if (r.ok) {
            const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url; a.download = 'agent-config.json'; a.click()
            URL.revokeObjectURL(url)
          }
        }}>配置 JSON</button>
        <button onClick={onRefresh} disabled={loading}>{loading ? '刷新中' : '刷新'}</button>
      </div>
    </header>
  )
}

function getPersonaHistoryKey(personaName = '') {
  const key = personaName ? personaName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80) : 'default'
  return `agent_console_history:${key}`
}

function renderRounds(rounds: RoundRecord[]) {
  if (!rounds || rounds.length === 0) return null
  const toolRoundCount = rounds.filter(r => r.toolCalls && r.toolCalls.length > 0).length
  const label = toolRoundCount > 0 ? `工具链（${toolRoundCount} 轮${rounds[rounds.length - 1]?.reasoning ? ' + 思考' : ''}）` : `思考（${rounds.length} 轮）`
  return (
    <details className="timeline">
      <summary>{label}</summary>
      {rounds.map((round, i) => (
        <div key={i} className="timeline-round">
          {round.reasoning && (
            <details className="timeline-thinking">
              <summary>思考过程</summary>
              <pre>{round.reasoning}</pre>
            </details>
          )}
          {round.toolCalls && round.toolCalls.map((tc, j) => (
            <div key={j} className="timeline-tool">
              <strong>{tc.name}</strong>
              {round.toolResults && round.toolResults[j] && (
                <pre className={round.toolResults[j].ok ? 'ok' : 'error'}>
                  {round.toolResults[j].result.slice(0, 300)}
                </pre>
              )}
            </div>
          ))}
        </div>
      ))}
    </details>
  )
}

const COMMANDS = [
  { label: '/plan', description: '创建计划', value: '/plan ' },
  { label: '/approve', description: '确认工具', value: '/approve ' },
  { label: '/reject', description: '拒绝工具', value: '/reject ' },
  { label: '/status', description: '查看状态', value: '/status ' },
]

function ChatPage({ refresh, persona }: { refresh: () => void; persona: any }) {
  const personaName = persona?.dashboardPersona || ''
  const historyKey = getPersonaHistoryKey(personaName)
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try { return JSON.parse(localStorage.getItem(historyKey) || '[]') } catch { return [] }
  })
  const [loadedHistoryKey, setLoadedHistoryKey] = useState(historyKey)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [mode, setMode] = useState<AgentMode>('build')
  const [enableThinking, setEnableThinking] = useState(false)
  const [agentMode, setAgentMode] = useState(true)
  const [textareaRef, setTextareaRef] = useState<HTMLTextAreaElement | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [completion, setCompletion] = useState<{
    type: CompletionType
    query: string
    items: Array<{ label: string; description: string; value: string }>
    selectedIndex: number
  } | null>(null)

  useEffect(() => {
    try { setMessages(JSON.parse(localStorage.getItem(historyKey) || '[]')) } catch { setMessages([]) }
    setLoadedHistoryKey(historyKey)
  }, [historyKey])
  useEffect(() => {
    if (loadedHistoryKey !== historyKey) return
    localStorage.setItem(historyKey, JSON.stringify(messages.slice(-30)))
    localStorage.setItem('agent_console_history', JSON.stringify(messages.slice(-30)))
  }, [historyKey, loadedHistoryKey, messages])
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight
    }
  }, [messages])
  async function send() {
    const text = input.trim()
    if (!text || sending) return
    const history = messages.slice(-12).map(item => ({ role: item.role, content: item.content }))
    const pendingMessageId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setMessages(prev => [...prev, { role: 'user', content: text }, { role: 'system', content: '执行中...', id: pendingMessageId, pending: true }])
    setInput('')
    setSending(true)
    try {
      const result = await api.chat(text, history, enableThinking, agentMode)
      setMessages(prev => {
        const base = prev.filter(item => item.id !== pendingMessageId)
        const reply = result.ok ? (result.data?.reply || result.data?.result || result.data?.message || '(Agent 未返回内容)') : (result.message || result.data?.message || '请求失败')
        return [...base, { role: 'assistant', content: reply, pendingId: result.data?.pendingId, rounds: result.data?.rounds || [] }]
      })
      refresh()
    } catch (error: any) {
      setMessages(prev => {
        const base = prev.filter(item => item.id !== pendingMessageId)
        return [...base, { role: 'assistant', content: error?.message || '请求失败' }]
      })
    } finally {
      setSending(false)
    }
  }
  function onInputChange(text: string) {
    setInput(text)
    const cursorPos = textareaRef?.selectionStart || 0
    const textBeforeCursor = text.slice(0, cursorPos)
    const slashMatch = textBeforeCursor.match(/\/(\w*)$/)
    const atMatch = textBeforeCursor.match(/@(\S*)$/)
    const hashMatch = textBeforeCursor.match(/#(\w*)$/)
    if (slashMatch) {
      const query = slashMatch[1].toLowerCase()
      const items = COMMANDS.filter(c => c.label.slice(1).startsWith(query))
      setCompletion({ type: 'command', query, items, selectedIndex: 0 })
    } else if (atMatch) {
      setCompletion(null)
    } else if (hashMatch) {
      setCompletion(null)
    } else {
      setCompletion(null)
    }
  }
  function selectCompletion(item: { value: string }) {
    const cursorPos = textareaRef?.selectionStart || 0
    const textBeforeCursor = input.slice(0, cursorPos)
    const textAfterCursor = input.slice(cursorPos)
    const match = textBeforeCursor.match(/\/\w*$/)
    const newText = match ? textBeforeCursor.slice(0, match.index) + item.value + textAfterCursor : input + item.value
    setInput(newText)
    setCompletion(null)
    setTimeout(() => textareaRef?.focus(), 0)
  }
  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (completion && completion.items.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCompletion({ ...completion, selectedIndex: Math.min(completion.selectedIndex + 1, completion.items.length - 1) })
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCompletion({ ...completion, selectedIndex: Math.max(completion.selectedIndex - 1, 0) })
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        selectCompletion(completion.items[completion.selectedIndex])
      } else if (event.key === 'Escape') {
        setCompletion(null)
      }
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send()
    if (event.key === 'Escape') setInput('')
  }
  function renderCompletion() {
    if (!completion || completion.items.length === 0) return null
    return (
      <div className="completion-popup">
        {completion.items.map((item, i) => (
          <button
            key={item.label}
            className={`completion-item ${i === completion.selectedIndex ? 'selected' : ''}`}
            onClick={() => selectCompletion(item)}
          >
            <span className="completion-label">{item.label}</span>
            <span className="completion-desc">{item.description}</span>
          </button>
        ))}
      </div>
    )
  }
  return (
    <section className="chat-layout">
      <div className="chat-head">
        <h2>新聊天</h2>
        <div className="chat-meta">
          <span>Console 人格：{personaName || '默认（东雪莲）'}</span>
          <span>当前模型跟随 Dashboard</span>
          <span>工具策略跟随 Agent 配置</span>
        </div>
      </div>
      <div className="messages" ref={messagesRef} onScroll={e => {
        const el = e.currentTarget
        setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 200)
      }}>
        {messages.length === 0 && <div className="empty">暂无对话</div>}
        {messages.map((message, index) => (
          <article key={index} className={'message ' + message.role}>
            <div className="avatar">{message.role === 'user' ? '你' : message.role === 'assistant' ? '莲' : '…'}</div>
            <div className="bubble">
              {message.role === 'assistant' && renderRounds(message.rounds)}
              <pre>{message.content}</pre>
              {message.pendingId && <span className="tag warn">等待确认 {message.pendingId}</span>}
            </div>
          </article>
        ))}
      </div>
      {showScrollBtn && (
        <button className="scroll-bottom-btn" onClick={() => {
          messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' })
        }}>↓ 底部</button>
      )}
      <div className="composer">
        <div className="composer-left">
          <button className={`mode-toggle ${mode}`} onClick={() => setMode(mode === 'plan' ? 'build' : 'plan')}>
            {mode === 'plan' ? 'Plan' : 'Build'}
          </button>
          <label className="thinking-toggle">
            <input type="checkbox" checked={agentMode} onChange={e => setAgentMode(e.target.checked)} />
            <span>Agent</span>
          </label>
          <label className="thinking-toggle">
            <input type="checkbox" checked={enableThinking} onChange={e => setEnableThinking(e.target.checked)} />
            <span>思考</span>
          </label>
        </div>
        <div className="composer-input-wrapper">
          <textarea ref={setTextareaRef} value={input} onChange={e => onInputChange(e.target.value)} onKeyDown={onComposerKeyDown} placeholder="/plan、/approve、@文件、#技能" />
          {renderCompletion()}
        </div>
        <div className="composer-actions">
          <span>{input.length} 字</span>
          <button onClick={send} disabled={sending || !input.trim()}>{sending ? '发送中' : '发送'}</button>
        </div>
      </div>
    </section>
  )
}

function InboxPage({ pending, pushLog, refresh }: { pending: any[]; pushLog: any[]; refresh: () => void }) {
  async function confirm(id: string) { await api.confirm(id); refresh() }
  async function reject(id: string) { await api.reject(id); refresh() }
  return (
    <div className="page-grid two">
      <section className="panel">
        <h2>审批</h2>
        {!pending.length && <div className="empty">暂无待审批项</div>}
        {pending.map(item => (
          <div className="approval-card" key={item.id}>
            <div>
              <strong>{item.toolName}</strong>
              <span>{item.channel}:{item.channelKey} / {item.userId}</span>
            </div>
            <p>{item.argsSummary}</p>
            <div className="row-actions">
              <button onClick={() => confirm(item.id)}>确认</button>
              <button className="secondary" onClick={() => reject(item.id)}>拒绝</button>
            </div>
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>推送消息</h2>
        {!pushLog.length && <div className="empty">暂无推送记录</div>}
        {pushLog.map((item, index) => (
          <div className="log-row" key={index}>
            <strong>{item.ok ? '成功' : '失败'} · {item.reason}</strong>
            <span>{item.channelKey} · {new Date(item.at).toLocaleString()}</span>
            <p>{item.preview || item.error}</p>
          </div>
        ))}
      </section>
    </div>
  )
}

function ToolsPage({ data, setConfig, refresh }: any) {
  const config = data.config?.config
  const tools = data.config?.tools || []
  async function toggle(toolName: string, channel: 'qq' | 'dashboard', enabled: boolean) {
    const next = structuredClone(config)
    next.channels[channel].tools[toolName] = enabled
    setConfig({ ...data.config, config: next })
    await api.saveConfig({ config: next, mode: data.config?.mode })
    refresh()
  }
  return (
    <section className="panel">
      <div className="section-head">
        <h2>内置工具</h2>
        <span>{tools.length} 个工具</span>
      </div>
      <div className="card-grid">
        {tools.map((tool: any) => (
          <article className="tool-card" key={tool.name}>
            <div className="tool-icon">{tool.name.slice(0, 2)}</div>
            <h3>{tool.name}</h3>
            <p>{tool.description}</p>
            <div className="tags">
              {tool.dangerous && <span className="tag danger">危险</span>}
              {tool.external && <span className="tag">外部网络</span>}
              {tool.write && <span className="tag warn">写入</span>}
              {tool.readOnly && <span className="tag ok">只读</span>}
            </div>
            {tool.name === 'execute_shell' && <span className="shell-note">Shell Guard 已启用</span>}
            <label><input type="checkbox" checked={!!config?.channels?.qq?.tools?.[tool.name]} onChange={e => toggle(tool.name, 'qq', e.target.checked)} /> QQ</label>
            <label><input type="checkbox" checked={!!config?.channels?.dashboard?.tools?.[tool.name]} onChange={e => toggle(tool.name, 'dashboard', e.target.checked)} /> Dashboard</label>
          </article>
        ))}
      </div>
    </section>
  )
}

function SkillsPage({ data, setConfig, refresh }: any) {
  const config = data.config?.config
  const skills = data.config?.skills || []
  async function toggle(skillName: string, enabled: boolean) {
    const next = structuredClone(config)
    const current = new Set(Array.isArray(next.enabledSkills) ? next.enabledSkills : [])
    if (enabled) current.add(skillName)
    else current.delete(skillName)
    next.enabledSkills = Array.from(current)
    setConfig({ ...data.config, config: next })
    await api.saveConfig({ config: next, mode: data.config?.mode })
    refresh()
  }
  return (
    <section className="panel">
      <div className="section-head">
        <h2>技能</h2>
        <span>{skills.length} 个实用 Skill</span>
      </div>
      <div className="card-grid">
        {(skills || []).map(skill => (
          <article className="skill-card" key={skill.name}>
            <h3>{skill.name}</h3>
            <p>{skill.description || '无描述'}</p>
            <div className="tags">
              <span className={config?.enabledSkills?.includes(skill.name) ? 'tag ok' : 'tag'}>{config?.enabledSkills?.includes(skill.name) ? '已启用' : '已禁用'}</span>
              <span className="tag">{skill.kind || 'skill'}</span>
              {skill.references?.length > 0 && <span className="tag">参考 {skill.references.length}</span>}
            </div>
            <label className="switch-row">
              <input type="checkbox" checked={!!config?.enabledSkills?.includes(skill.name)} onChange={event => toggle(skill.name, event.target.checked)} />
              <span>注入轻量索引，允许 Agent 按需读取</span>
            </label>
          </article>
        ))}
      </div>
    </section>
  )
}

function PersonasPage({ personas, persona, setPersona, refresh }: { personas: any[]; persona: any; setPersona: (value: any) => void; refresh: () => void }) {
  const current = persona?.dashboardPersona || ''
  const inherit = persona?.qqInheritChatPersona !== false
  const [message, setMessage] = useState('')
  async function save(nextName: string, nextInherit = inherit) {
    const result = await api.savePersona({ dashboardPersona: nextName, qqInheritChatPersona: nextInherit })
    if (result.ok) {
      setPersona(result.data?.persona || { dashboardPersona: nextName, qqInheritChatPersona: nextInherit })
      setMessage('人格已更新')
      window.dispatchEvent(new CustomEvent('agent-console-persona-changed', { detail: { dashboardPersona: nextName } }))
      refresh()
    } else {
      setMessage(result.message || result.data?.message || '人格更新失败')
    }
  }
  return (
    <section className="panel">
      <div className="section-head">
        <h2>人格</h2>
        <span>{current || '默认（东雪莲）'}</span>
      </div>
      <div className="setting-grid">
        <label>
          <span>QQ 继承聊天人格</span>
          <input type="checkbox" checked={inherit} onChange={e => save(current, e.target.checked)} />
        </label>
      </div>
      <div className="row-actions">
        <button className={!current ? 'active' : ''} onClick={() => save('')}>默认人格</button>
      </div>
      {message && <span className="form-error">{message}</span>}
      <div className="card-grid">
        {(personas || []).map(item => (
          <article className={'skill-card persona-card ' + (current === item.name ? 'selected' : '')} key={item.name}>
            <h3>{item.name}</h3>
            <p>{item.description || '无描述'}</p>
            <div className="tags">
              {item.lore && <span className="tag">{item.lore}</span>}
              <span className={current === item.name ? 'tag ok' : 'tag'}>{current === item.name ? 'Console 使用中' : '可选'}</span>
            </div>
            <button onClick={() => save(item.name)} disabled={current === item.name}>设为 Console 人格</button>
          </article>
        ))}
      </div>
    </section>
  )
}

function FilesPage({ roots }: { roots: string[] }) {
  const [root, setRoot] = useState('')
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<any[]>([])
  const [preview, setPreview] = useState<any>(null)
  const [draft, setDraft] = useState({ name: '', content: '' })
  const [message, setMessage] = useState('')
  async function loadFiles(nextRoot = root, nextQuery = query) {
    const result = await api.files(nextRoot, nextQuery)
    if (result.ok) {
      setFiles(result.data?.files || [])
      setRoot(result.data?.root || nextRoot || roots[0] || '')
      setMessage('')
    } else {
      setMessage(result.message || result.data?.message || '文件列表读取失败')
    }
  }
  async function openFile(file: any) {
    if (file.type === 'dir') return loadFiles(file.path, '')
    const result = await api.filePreview(file.path)
    if (result.ok) setPreview(result.data?.file)
    else setMessage(result.message || result.data?.message || '预览失败')
  }
  async function upload() {
    if (!draft.name.trim()) return
    const result = await api.fileUpload({ root: root || roots[0], name: draft.name, content: draft.content })
    if (result.ok) {
      setDraft({ name: '', content: '' })
      setMessage('上传完成')
      loadFiles()
    } else {
      setMessage(result.message || result.data?.message || '上传失败')
    }
  }
  async function downloadFile(file: any) {
    try {
      const blob = await api.fileDownload(file.path)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name || 'download'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (error: any) {
      setMessage(error?.message || '下载失败')
    }
  }
  useEffect(() => { loadFiles(roots[0] || '', '') }, [roots.join('|')])
  return (
    <div className="page-grid two">
      <section className="panel">
        <div className="section-head"><h2>文件工作区</h2><span>{files.length} 项</span></div>
        <div className="search-line">
          <select value={root} onChange={e => { setRoot(e.target.value); loadFiles(e.target.value, query) }}>
            {(roots || []).map(item => <option key={item} value={item}>{item}</option>)}
            {root && !roots.includes(root) && <option value={root}>{root}</option>}
          </select>
          <input placeholder="搜索文件名" value={query} onChange={e => setQuery(e.target.value)} />
          <button onClick={() => loadFiles(root, query)}>刷新</button>
        </div>
        {message && <span className="form-error">{message}</span>}
        <div className="file-list">
          {files.map(file => (
            <button className="file-row file-button" key={file.path} onClick={() => openFile(file)}>
              <strong>{file.type === 'dir' ? '目录' : '文件'} · {file.rel || file.name}</strong>
              <span>{file.size} bytes · {new Date(file.mtimeMs).toLocaleString()} · {file.injectable ? '可注入上下文' : '仅元信息'}</span>
            </button>
          ))}
        </div>
        <div className="upload-box">
          <h3>上传文本</h3>
          <input placeholder="文件名" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
          <textarea placeholder="文件内容" value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} />
          <button onClick={upload}>上传</button>
        </div>
      </section>
      <section className="panel preview">
        <h2>预览</h2>
        {!preview && <div className="empty">选择文件后显示 Markdown 或文本预览</div>}
        {preview && (
          <div className="preview-body">
            <div className="section-head">
              <h3>{preview.name}</h3>
              <button className="secondary" onClick={() => downloadFile(preview)}>下载</button>
            </div>
            <p className="muted">{preview.path} · {preview.size} bytes · {new Date(preview.mtimeMs).toLocaleString()}</p>
            {preview.binary ? <div className="empty">二进制文件仅展示元信息</div> : <pre>{preview.content || (preview.truncated ? '文件过大，仅展示元信息' : '')}</pre>}
          </div>
        )}
      </section>
    </div>
  )
}

function PlansPage({ plans, refresh }: { plans: any[]; refresh: () => void }) {
  const [goal, setGoal] = useState('')
  const [message, setMessage] = useState('')
  async function createPlan() {
    const text = goal.trim()
    if (!text) return
    const result = await api.createPlan(text)
    if (result.ok && result.data?.plan?.id) {
      const resumed = await api.resumePlan(result.data.plan.id)
      setMessage(resumed.ok ? (resumed.data?.reply || '计划已创建并开始执行') : ('计划已创建，但启动失败：' + (resumed.message || resumed.data?.message || '未知错误')))
    } else {
      setMessage(result.message || result.data?.message || '计划创建失败')
    }
    setGoal('')
    refresh()
  }
  async function abandonPlan(planId: string) {
    const result = await api.abandonPlan(planId)
    setMessage(result.ok ? '计划已放弃' : (result.message || result.data?.message || '计划放弃失败'))
    refresh()
  }
  async function resumePlan(planId: string) {
    const result = await api.resumePlan(planId)
    setMessage(result.ok ? (result.data?.reply || '计划已继续执行') : (result.message || result.data?.message || '计划继续失败'))
    refresh()
  }
  return (
    <section className="panel">
      <div className="section-head"><h2>计划</h2><span>{plans.length} 个</span></div>
      <div className="inline-form">
        <input value={goal} onChange={e => setGoal(e.target.value)} placeholder="多步骤目标" />
        <button onClick={createPlan} disabled={!goal.trim()}>创建计划</button>
      </div>
      {message && <span className="form-error">{message}</span>}
      {!plans.length && <div className="empty">暂无计划</div>}
      <div className="list">
        {plans.map(plan => (
          <article className="plan-card" key={plan.id}>
            <div className="section-head"><h3>{plan.title}</h3><span>{plan.state}</span></div>
            <p>{plan.id} · {plan.channel}:{plan.channelKey}</p>
            <div className="task-list">
              {plan.tasks.map((task: any) => <span key={task.id} className={'task ' + task.state}>{task.id} {task.state}</span>)}
            </div>
            {plan.state === 'executing' && <div className="row-actions"><button onClick={() => resumePlan(plan.id)}>继续</button><button className="secondary" onClick={() => abandonPlan(plan.id)}>放弃</button></div>}
          </article>
        ))}
      </div>
    </section>
  )
}

function CronPage({ crons, history, refresh }: { crons: any[]; history: any[]; refresh: () => void }) {
  const [draft, setDraft] = useState({ id: '', schedule: '0 20 * * *', type: 'text', prompt: '', targetChannel: '', enabled: true })
  async function create() { await api.createCron(draft); setDraft({ ...draft, id: '', prompt: '' }); refresh() }
  return (
    <div className="page-grid two">
      <section className="panel">
        <h2>定时任务</h2>
        <div className="form-grid">
          <input placeholder="id" value={draft.id} onChange={e => setDraft({ ...draft, id: e.target.value })} />
          <input placeholder="cron" value={draft.schedule} onChange={e => setDraft({ ...draft, schedule: e.target.value })} />
          <input placeholder="目标频道" value={draft.targetChannel} onChange={e => setDraft({ ...draft, targetChannel: e.target.value })} />
          <select value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value })}><option value="text">text</option><option value="agent">agent</option></select>
          <textarea placeholder="prompt/text" value={draft.prompt} onChange={e => setDraft({ ...draft, prompt: e.target.value })} />
          <button onClick={create}>创建</button>
        </div>
        {crons.map(cron => (
          <div className="approval-card" key={cron.id}>
            <strong>{cron.id}</strong>
            <span>{cron.schedule} · {cron.type} · {cron.enabled ? '启用' : '停用'}</span>
            <p>{cron.prompt}</p>
            <div className="row-actions"><button onClick={() => api.runCron(cron.id).then(refresh)}>立即运行</button><button className="secondary" onClick={() => api.deleteCron(cron.id).then(refresh)}>删除</button></div>
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>执行记录</h2>
        {history.map((item, index) => <div className="log-row" key={index}><strong>{item.id} · {item.ok ? '成功' : '失败'}</strong><p>{item.result}</p></div>)}
      </section>
    </div>
  )
}

function StatsPage({ stats, queue, sessions }: { stats: any; queue: any; sessions: any[] }) {
  const metrics = [
    ['总会话数', sessions.length],
    ['工具调用数', stats?.total || 0],
    ['成功率', (stats?.successRate || 0) + '%'],
    ['平均耗时', (stats?.avgDurationMs || 0) + 'ms'],
    ['Token 估算', stats?.totalTokens || 0],
    ['队列活跃', queue?.activeCount || 0],
    ['队列等待', queue?.waitingCount || 0],
    ['超时次数', queue?.timeoutCount || 0],
  ]
  return (
    <section className="panel">
      <h2>智能体统计</h2>
      <div className="metric-grid">{metrics.map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="page-grid two">
        <div><h3>按工具</h3>{Object.entries(stats?.byToolDetail || {}).map(([name, item]: any) => <div className="bar-row" key={name}><span>{name}</span><strong>{item.total}</strong></div>)}</div>
        <div><h3>最近会话</h3>{sessions.slice(0, 10).map(session => <div className="bar-row" key={session.id}><span>{session.title}</span><strong>{session.toolCalls}</strong></div>)}</div>
      </div>
    </section>
  )
}

function ModelPage({ config }: { config: any }) {
  return (
    <section className="panel">
      <h2>模型</h2>
      <div className="metric-grid">
        <div className="metric"><span>Provider</span><strong>跟随 Dashboard</strong></div>
        <div className="metric"><span>QQ 自动路由</span><strong>{config?.config?.autoRoute?.qq?.enabled ? '开启' : '关闭'}</strong></div>
        <div className="metric"><span>Dashboard Agent</span><strong>{config?.config?.channels?.dashboard?.enabled ? '开启' : '关闭'}</strong></div>
      </div>
      <p className="muted">API Key 只显示已配置状态，不在 Agent Console 明文展示。</p>
    </section>
  )
}

function RuntimePage({ data, refresh }: any) {
  const config = data.config?.config
  const [draft, setDraft] = useState<any>(() => config ? structuredClone(config) : null)
  const [message, setMessage] = useState('')
  useEffect(() => { if (config) setDraft(structuredClone(config)) }, [config])
  if (!draft) return <section className="panel"><div className="empty">配置加载中</div></section>
  async function save() {
    const result = await api.saveConfig({ config: draft, mode: data.config?.mode })
    setMessage(result.ok ? '运行配置已保存' : (result.message || result.data?.message || '保存失败'))
    refresh()
  }
  function update(path: string[], value: any) {
    const next = structuredClone(draft)
    let cursor = next
    for (const key of path.slice(0, -1)) cursor = cursor[key]
    cursor[path[path.length - 1]] = value
    setDraft(next)
  }
  return (
    <section className="panel">
      <h2>运行配置</h2>
      <div className="setting-grid">
        <label><span>QQ Agent</span><input type="checkbox" checked={!!draft.channels.qq.enabled} onChange={e => update(['channels', 'qq', 'enabled'], e.target.checked)} /></label>
        <label><span>Dashboard Agent</span><input type="checkbox" checked={!!draft.channels.dashboard.enabled} onChange={e => update(['channels', 'dashboard', 'enabled'], e.target.checked)} /></label>
        <label><span>QQ 自动路由</span><input type="checkbox" checked={!!draft.autoRoute.qq.enabled} onChange={e => update(['autoRoute', 'qq', 'enabled'], e.target.checked)} /></label>
        <label><span>计划模式</span><input type="checkbox" checked={!!draft.planMode.enabled} onChange={e => update(['planMode', 'enabled'], e.target.checked)} /></label>
        <label><span>Cron</span><input type="checkbox" checked={!!draft.cron.enabled} onChange={e => update(['cron', 'enabled'], e.target.checked)} /></label>
        <label><span>Push</span><input type="checkbox" checked={!!draft.push.enabled} onChange={e => update(['push', 'enabled'], e.target.checked)} /></label>
        <label><span>全局并发</span><input type="number" min="1" max="12" value={draft.queue.maxGlobal} onChange={e => update(['queue', 'maxGlobal'], Number(e.target.value))} /></label>
        <label><span>频道并发</span><input type="number" min="1" max="20" value={draft.queue.maxPerChannel} onChange={e => update(['queue', 'maxPerChannel'], Number(e.target.value))} /></label>
        <label><span>用户等待数</span><input type="number" min="0" max="10" value={draft.queue.maxPendingPerUser} onChange={e => update(['queue', 'maxPendingPerUser'], Number(e.target.value))} /></label>
        <label><span>任务超时 ms</span><input type="number" min="5000" value={draft.queue.timeoutMs} onChange={e => update(['queue', 'timeoutMs'], Number(e.target.value))} /></label>
        <label><span>Push 日额度</span><input type="number" min="0" max="100" value={draft.push.dailyLimit} onChange={e => update(['push', 'dailyLimit'], Number(e.target.value))} /></label>
        <label><span>记忆管理员限定</span><input type="checkbox" checked={!!draft.memory.adminOnly} onChange={e => update(['memory', 'adminOnly'], e.target.checked)} /></label>
      </div>
      <div className="row-actions"><button onClick={save}>保存</button></div>
      {message && <span className="form-error">{message}</span>}
    </section>
  )
}

function EnvPage({ env }: { env: any }) {
  const rows = env?.env || []
  return (
    <section className="panel">
      <h2>环境变量</h2>
      <div className="metric-grid">
        <div className="metric"><span>Provider</span><strong>{env?.runtime?.provider || '未配置'}</strong></div>
        <div className="metric"><span>Model</span><strong>{env?.runtime?.model || '未配置'}</strong></div>
        <div className="metric"><span>API Key</span><strong>{env?.runtime?.apiKeyConfigured ? '已配置' : '未配置'}</strong></div>
        <div className="metric"><span>联网搜索</span><strong>{env?.runtime?.searchEnabled ? '开启' : '关闭'}</strong></div>
      </div>
      <div className="list">
        {rows.map((item: any) => (
          <div className="bar-row" key={item.name}>
            <span>{item.name}</span>
            <strong>{item.configured ? '已配置' : '未配置'} · {item.size} bytes</strong>
          </div>
        ))}
      </div>
    </section>
  )
}

function SecurityPage({ shellGuard, config }: { shellGuard: any; config: any }) {
  return (
    <section className="panel">
      <h2>安全 / Shell Guard</h2>
      <div className="metric-grid">
        <div className="metric"><span>安全模式</span><strong>{config?.mode || 'config'}</strong></div>
        <div className="metric"><span>规则数</span><strong>{shellGuard?.ruleCount || 0}</strong></div>
        <div className="metric"><span>危险策略</span><strong>{config?.config?.dangerousPolicy || 'confirm'}</strong></div>
      </div>
      <div className="card-grid">
        {(shellGuard?.categories || []).map((category: any) => (
          <article className="skill-card" key={category.category}>
            <h3>{category.label}</h3>
            <p>{category.description}</p>
            <span className="tag danger">{category.count} 条</span>
          </article>
        ))}
      </div>
    </section>
  )
}

function App() {
  const [verified, setVerified] = useState(() => !!localStorage.getItem('dashboard_server_token') || !!localStorage.getItem('dashboard_admin_token'))
  const [active, setActive] = useState<TabId>('chat')
  const [showAdminDialog, setShowAdminDialog] = useState(false)
  const data = useAgentData()
  useEffect(() => {
    if (data.adminRequired) setShowAdminDialog(true)
  }, [data.adminRequired])
  if (!verified) return <AdminGate onVerified={() => { setVerified(true); data.refresh() }} />
  const version = data.config?.config?.version || '1.1.5'
  return (
    <div className="shell">
      {showAdminDialog && <AdminDialog onVerified={() => { setShowAdminDialog(false); data.refresh() }} />}
      <Sidebar active={active} setActive={setActive} version={String(version)} />
      <main className="workspace">
        <Topbar onRefresh={data.refresh} loading={data.loading} />
        {data.error && <div className="error-banner">{data.error}</div>}
        {active === 'chat' && <ChatPage refresh={data.refresh} persona={data.persona} />}
        {active === 'inbox' && <InboxPage pending={data.pending} pushLog={data.pushLog} refresh={data.refresh} />}
        {active === 'personas' && <PersonasPage personas={data.personas} persona={data.persona} setPersona={data.setPersona} refresh={data.refresh} />}
        {active === 'files' && <FilesPage roots={data.config?.effectiveReadRoots || []} />}
        {active === 'skills' && <SkillsPage data={data} setConfig={data.setConfig} refresh={data.refresh} />}
        {active === 'tools' && <ToolsPage data={data} setConfig={data.setConfig} refresh={data.refresh} />}
        {active === 'plans' && <PlansPage plans={data.plans} refresh={data.refresh} />}
        {active === 'cron' && <CronPage crons={data.crons} history={data.cronHistory} refresh={data.refresh} />}
        {active === 'stats' && <StatsPage stats={data.stats} queue={data.queue} sessions={data.sessions} />}
        {active === 'runtime' && <RuntimePage data={data} refresh={data.refresh} />}
        {active === 'model' && <ModelPage config={data.config} />}
        {active === 'env' && <EnvPage env={data.env} />}
        {active === 'security' && <SecurityPage shellGuard={data.shellGuard} config={data.config} />}
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
