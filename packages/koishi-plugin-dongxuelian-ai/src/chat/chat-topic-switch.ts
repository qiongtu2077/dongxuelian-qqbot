/**
 * MODULE: chat-topic-switch
 * 职责: 串行判断 chat.js 当前消息是否切换话题。
 * 边界: 不清理 conversation、不清理 Agent context、不反向依赖 chat.js。
 * 状态: topicSwitchLocks 保存每个 conversation key 的检测串行锁。
 */
const { requestChatCompletions } = require('../core/api') as typeof import('../core/api')
const { getRecentUserMessages } = require('../conversation') as typeof import('../conversation')
const { loadConfig } = require('../core/runtime-config') as typeof import('../core/runtime-config')
import { ChatTurnBudget, CHAT_TURN_LIMITS, currentChatTurn, waitWithSignal } from '../lifecycle/chat-turn-budget'
import type { TurnStage } from '../lifecycle/chat-turn-budget'

type TopicSwitchResult = boolean | null

interface TopicSwitchSessionLike {
  guildId?: string
  channelId?: string
  isDirect?: boolean
  userId?: string
  username?: string
  messageId?: string
  selfId?: string
  author?: { id?: string }
  bot?: { selfId?: string }
}

interface TopicSwitchOptions {
  topicKey?: string
  session?: TopicSwitchSessionLike
  currentText?: string
}

const topicSwitchLocks: Map<string, Promise<TopicSwitchResult>> = new Map()
const topicControllers = new Set<AbortController>()

function getTopicSwitchErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'unknown error')
}

function getTopicSwitchReplyContent(result: Awaited<ReturnType<typeof requestChatCompletions>>): string {
  if (typeof result === 'string') return result
  if (result && result.type === 'text') return result.content || ''
  return ''
}

// 话题检测：轻量模型优先 → 主模型兜底 → 都失败则返回 null（由调用方决定降级策略）
async function detectTopicSwitch(lastMsg: string, currentMsg: string, stage?: TurnStage): Promise<TopicSwitchResult> {
  if (!lastMsg || !currentMsg) return false
  const ownedStage = stage ? null : (currentChatTurn() || new ChatTurnBudget({ channelKey: 'topic' })).openStage('topic', CHAT_TURN_LIMITS.topic)
  const activeStage = stage || ownedStage!
  const prompt = [
    { role: 'system', content: '判断用户是否切换了话题。只回复 YES 或 NO。' },
    { role: 'user', content: `上一条消息：${lastMsg.slice(0, 200)}\n当前消息：${currentMsg.slice(0, 200)}` },
  ]
  try {
    const config = await loadConfig()
    if (!config.apiKey) return null
    if (activeStage.signal.aborted || Date.now() >= activeStage.deadline) return null
    const result = await requestChatCompletions(prompt, config, { max_tokens: 256, _timeoutMs: 8000, _purpose: 'topic_switch',
      signal: activeStage.signal, _timeBudget: { deadline: activeStage.deadline, primaryMs: 8000, fallbackMs: 8000, fallbackReserveMs: 0 } })
    currentChatTurn()?.assertActive()
    if (activeStage.signal.aborted || Date.now() >= activeStage.deadline) return null
    const reply = getTopicSwitchReplyContent(result)
    if (/^YES/i.test(reply)) return true
    if (/^NO/i.test(reply)) return false
  } catch (err) {
    currentChatTurn()?.assertActive()
    console.warn('[chat-topic-switch] detectTopicSwitch failed:', getTopicSwitchErrorMessage(err))
  } finally { ownedStage?.close() }
  return null
}

// 锁等待及所有节点共享八秒；已过期等候者不会在锁释放后补发请求。
async function resolveTopicSwitch({ topicKey = '', session, currentText = '' }: TopicSwitchOptions = {}): Promise<TopicSwitchResult> {
  const key = String(topicKey || '')
  const turn = currentChatTurn()
  const stage = (turn || new ChatTurnBudget({ channelKey: key })).openStage('topic', CHAT_TURN_LIMITS.topic)
  const disposal = new AbortController()
  topicControllers.add(disposal)
  const signal = AbortSignal.any([stage.signal, disposal.signal])
  const prevLock = topicSwitchLocks.get(key) || Promise.resolve(null)
  const work = waitWithSignal(prevLock.catch(() => null), signal).then(async () => {
    turn?.assertActive()
    if (signal.aborted || Date.now() >= stage.deadline) return null
    const lastUserMsg = session ? getRecentUserMessages(session, 1).pop() : undefined
    return lastUserMsg ? detectTopicSwitch(lastUserMsg, currentText, { ...stage, signal }) : false
  })
  // 取消等待不能提前释放仍被前任占有的锁；所有拒绝均在此消费。
  const lockPromise = Promise.allSettled([prevLock, work]).then(() => null)
  topicSwitchLocks.set(key, lockPromise)
  void lockPromise.then(() => { if (topicSwitchLocks.get(key) === lockPromise) topicSwitchLocks.delete(key) })
  try { return await work } catch { turn?.assertActive(); return null }
  finally { stage.close(); topicControllers.delete(disposal) }
}

// 卸载撤销尚在等待及运行的判断；真实锁仍等待其请求退出。
function clearTopicSwitchLocks(): void {
  for (const controller of topicControllers) controller.abort(new Error('topic_disposed'))
  topicControllers.clear()
}

export = {
  detectTopicSwitch,
  resolveTopicSwitch,
  clearTopicSwitchLocks,
}
