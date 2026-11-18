import React, { useEffect, useRef, useState } from 'react'
import { api, getErrorMessage } from './api/client'
import type { AgentPersonaConfig } from './api/types'
import { buildChatHistory, readChatImages } from './chat-images'

// --- 聊天历史和交互 --- #

type RoundRecord = {
  reasoning: string | null
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>
  toolResults?: Array<{ name: string; result: string; ok: boolean }>
}

type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  images?: string[]
  imageCount?: number
  pendingId?: string
  id?: string
  pending?: boolean
  rounds?: RoundRecord[]
}

type AgentMode = 'plan' | 'build'

type CompletionType = 'command' | 'file' | 'skill' | null

/** Keeps remembered chat history separate for each persona. */
function getPersonaHistoryKey(personaName = '') {
  const key = personaName ? personaName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80) : 'default'
  return `agent_console_history:${key}`
}

const AGENT_CONSOLE_REMEMBER_HISTORY_KEY = 'agent_console_remember_history'

/** Renders the response's recorded tool and thinking rounds. */
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

/** Owns the active persona's conversation and cancels result polling when the page is left. */
/** Owns the composer and its background task until the chat page unmounts. */
export function ChatPage({ onSettled, persona }: { onSettled: (code?: string) => void; persona: AgentPersonaConfig | null }) {
  const personaName = persona?.dashboardPersona || ''
  const historyKey = getPersonaHistoryKey(personaName)
  const [rememberHistory, setRememberHistory] = useState(() => localStorage.getItem(AGENT_CONSOLE_REMEMBER_HISTORY_KEY) === '1')
  const [messages, setMessages] = useState<ChatMessage[]>(() => [])
  const [loadedHistoryKey, setLoadedHistoryKey] = useState(historyKey)
  const [input, setInput] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [imageError, setImageError] = useState('')
  const [readingImages, setReadingImages] = useState(false)
  const imageReadRef = useRef(0)
  const imageReadingRef = useRef(false)
  const [sending, setSending] = useState(false)
  const [mode, setMode] = useState<AgentMode>('build')
  const [enableThinking, setEnableThinking] = useState(false)
  const [agentMode, setAgentMode] = useState(true)
  const chatRequestRef = useRef<AbortController | null>(null)
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
    setSending(false)
    setImages([])
    setImageError('')
    setReadingImages(false)
    imageReadingRef.current = false
    // Changing persona or leaving chat stops this page's polling, while the worker owns the task.
    return () => { chatRequestRef.current?.abort(); chatRequestRef.current = null; imageReadRef.current += 1 }
  }, [historyKey])
  useEffect(() => {
    if (!rememberHistory) {
      setMessages([])
      localStorage.removeItem(historyKey)
      localStorage.removeItem('agent_console_history')
      setLoadedHistoryKey(historyKey)
      return
    }
    try { setMessages(JSON.parse(localStorage.getItem(historyKey) || '[]')) } catch { setMessages([]) }
    setLoadedHistoryKey(historyKey)
  }, [historyKey, rememberHistory])
  useEffect(() => {
    if (loadedHistoryKey !== historyKey) return
    if (rememberHistory) {
      // Image bytes stay in this chat's memory; storing base64 would exhaust Web Storage's quota.
      const saved = JSON.stringify(messages.slice(-30).map(({ images: attached, ...item }) => ({ ...item, imageCount: attached?.length || item.imageCount })))
      localStorage.setItem(historyKey, saved)
      localStorage.setItem('agent_console_history', saved)
    } else {
      localStorage.removeItem(historyKey)
      localStorage.removeItem('agent_console_history')
    }
  }, [historyKey, loadedHistoryKey, messages, rememberHistory])
  useEffect(() => {
    if (rememberHistory) localStorage.setItem(AGENT_CONSOLE_REMEMBER_HISTORY_KEY, '1')
    else localStorage.removeItem(AGENT_CONSOLE_REMEMBER_HISTORY_KEY)
  }, [rememberHistory])
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight
    }
  }, [messages])
  /** Submits chat and keeps its pending message until the background worker returns the final result. */
  async function send() {
    const text = input.trim() || (images.length ? '请查看图片。' : '')
    if (!text || chatRequestRef.current || imageReadingRef.current) return
    const attached = images
    const history = buildChatHistory(messages, attached)
    const pendingMessageId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setMessages(prev => [...prev, { role: 'user', content: text, images: attached }, { role: 'system', content: '执行中...', id: pendingMessageId, pending: true }])
    setInput('')
    setImages([])
    setImageError('')
    setSending(true)
    const controller = new AbortController()
    chatRequestRef.current = controller
    try {
      const result = await api.chat(text, history, enableThinking, agentMode, controller.signal, attached.length ? attached : undefined)
      if (controller.signal.aborted) return
      setMessages(prev => {
        const base = prev.filter(item => item.id !== pendingMessageId)
        const reply = result.ok ? (result.data?.reply || result.data?.result || result.data?.message || '(Agent 未返回内容)') : (result.message || result.data?.message || '请求失败')
        return [...base, { role: 'assistant', content: reply, pendingId: result.data?.pendingId, rounds: result.data?.rounds || [] }]
      })
      onSettled(result.code)
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      setMessages(prev => {
        const base = prev.filter(item => item.id !== pendingMessageId)
        return [...base, { role: 'assistant', content: getErrorMessage(error) }]
      })
    } finally {
      if (chatRequestRef.current === controller) {
        chatRequestRef.current = null
        setSending(false)
      }
    }
  }
  /** Reads pasted image files and preserves ordinary text paste, including mixed clipboard content. */
  async function onComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'))
    if (!files.length) return
    event.preventDefault()
    if (imageReadingRef.current) {
      setImageError('图片正在读取，请稍候再粘贴')
      return
    }
    const pastedText = event.clipboardData.getData('text/plain')
    if (pastedText) {
      const { selectionStart, selectionEnd } = event.currentTarget
      setInput(prev => prev.slice(0, selectionStart) + pastedText + prev.slice(selectionEnd))
    }
    const version = ++imageReadRef.current
    imageReadingRef.current = true
    setReadingImages(true)
    setImageError('')
    try {
      const added = await readChatImages(files, images)
      if (version === imageReadRef.current) setImages(prev => [...prev, ...added])
    } catch (error: unknown) {
      if (version === imageReadRef.current) setImageError(getErrorMessage(error, '读取图片失败'))
    } finally {
      if (version === imageReadRef.current) {
        imageReadingRef.current = false
        setReadingImages(false)
      }
    }
  }
  /** Updates text and slash-command completion at the current cursor position. */
  /** Updates the draft and the suggestions adjacent to the current cursor. */
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
  /** Inserts a suggestion at the active composer cursor. */
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
  /** Routes keyboard controls to suggestions or the send action. */
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
  /** Renders the active list of composer suggestions. */
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
              {message.role === 'assistant' && renderRounds(message.rounds || [])}
              {!!message.images?.length && <div className="message-images">{message.images.map((url, imageIndex) => <img key={imageIndex} src={url} alt={`图片 ${imageIndex + 1}`} />)}</div>}
              {!message.images?.length && !!message.imageCount && <p className="muted">已发送 {message.imageCount} 张图片（原图未保存在本机历史中）</p>}
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
          <label className="thinking-toggle">
            <input type="checkbox" checked={rememberHistory} onChange={e => setRememberHistory(e.target.checked)} />
            <span>记住本机历史</span>
          </label>
        </div>
        {!!images.length && <div className="composer-images" aria-label="待发送图片">
          {images.map((url, index) => <div className="composer-image" key={index}>
            <img src={url} alt={`待发送图片 ${index + 1}`} />
            <button type="button" aria-label={`移除图片 ${index + 1}`} disabled={readingImages} onClick={() => { setImages(prev => prev.filter((_, i) => i !== index)); setImageError('') }}>×</button>
          </div>)}
        </div>}
        {readingImages && <p className="muted" role="status">正在读取图片…</p>}
        {imageError && <p className="form-error" role="alert">{imageError}</p>}
        <div className="composer-input-wrapper">
          <textarea ref={setTextareaRef} value={input} onChange={e => onInputChange(e.target.value)} onKeyDown={onComposerKeyDown} onPaste={onComposerPaste} placeholder="/plan、/approve、@文件、#技能；支持粘贴图片" />
          {renderCompletion()}
        </div>
        <div className="composer-actions">
          <span>{input.length} 字{images.length ? ` · ${images.length} 张图片` : ''}</span>
          <button onClick={send} disabled={sending || readingImages || (!input.trim() && !images.length)}>{sending ? '发送中' : '发送'}</button>
        </div>
      </div>
    </section>
  )
}
