/**
 * MODULE: 向 QQ 用户/群发送文件工具。
 * 安全：限定路径白名单；OneBot 不可用时降级说明。
 */
const fs = require('fs/promises')
const path = require('path')
const WebSocket = require('ws') as typeof import('ws')
const { assertExistingAgentPathInsideRoots } = require('../path-guard') as typeof import('../path-guard')
const { resolveOneBotWsUrl } = require('../../core/onebot-endpoint') as typeof import('../../core/onebot-endpoint')

interface SendFileParams {
  path?: unknown
  groupId?: unknown
  userId?: unknown
  name?: unknown
}

interface SendFileContext {
  channelKey?: string
  userId?: string
  groupId?: unknown
  callOneBot?: (action: string, params: Record<string, unknown>) => Promise<OneBotResult>
}

interface FileStatLike {
  size: number
  isFile: () => boolean
}

interface OneBotResult {
  ok: boolean
  message?: string
  data?: unknown
}

interface OneBotResponse {
  echo?: unknown
  status?: string
  retcode?: number
  message?: string
  wording?: string
  data?: unknown
}

const MAX_SEND_FILE_BYTES = 64 * 1024 * 1024

function getSendFileErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'OneBot 不可用')
}

function callOneBot(action: string, params: Record<string, unknown>, timeoutMs: number = 5000): Promise<OneBotResult> {
  return new Promise(resolve => {
    let ws: InstanceType<typeof WebSocket> | null = null
    let timer: NodeJS.Timeout | null = null
    let settled = false
    const echo = 'agent-send-file-' + Date.now()
    const finishOneBotSendFile = (value: OneBotResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { if (ws) ws.close() } catch {
        /* non-critical: websocket may already be closed */
      }
      resolve(value)
    }
    try {
      ws = new WebSocket(resolveOneBotWsUrl())
      const currentWs = ws
      timer = setTimeout(() => finishOneBotSendFile({ ok: false, message: 'OneBot 连接超时' }), timeoutMs)
      currentWs.on('open', () => currentWs.send(JSON.stringify({ action, params, echo })))
      ws.on('message', (raw: unknown) => {
        try {
          const data = JSON.parse(String(raw)) as OneBotResponse
          if (data.echo !== echo) return
          finishOneBotSendFile({ ok: data.status === 'ok' || data.retcode === 0, message: data.message || data.wording || '', data: data.data })
        } catch {
          finishOneBotSendFile({ ok: false, message: 'OneBot 响应解析失败' })
        }
      })
      ws.on('error', (err: unknown) => finishOneBotSendFile({ ok: false, message: getSendFileErrorMessage(err) }))
    } catch (e) { finishOneBotSendFile({ ok: false, message: getSendFileErrorMessage(e) }) }
  })
}

export = {
  definition: {
    name: 'send_file_to_user',
    description: '把允许工作区内的本地文件发送到当前 QQ 群或用户。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        groupId: { type: 'string', description: 'QQ群号，群聊发送时填写' },
        userId: { type: 'string', description: 'QQ用户号，私聊发送时填写' },
        name: { type: 'string', description: '发送时显示的文件名，可选' },
      },
      required: ['path'],
    },
  },
  async execute(params: SendFileParams = {}, context: SendFileContext = {}): Promise<string> {
    const filePath = String(params.path || '').trim()
    if (!filePath) throw new Error('路径不能为空')
    const { abs } = await assertExistingAgentPathInsideRoots(filePath, '文件')
    const stat = await fs.stat(abs) as FileStatLike
    if (!stat.isFile()) throw new Error(`不是文件：${filePath}`)
    if (stat.size > MAX_SEND_FILE_BYTES) throw new Error(`文件过大，拒绝通过 QQ 发送：${stat.size} bytes`)
    const contextGroupId = context.channelKey && !/^private(?::|$)/.test(String(context.channelKey))
      ? String(context.channelKey).split(':')[0]
      : ''
    const contextUserId = /^private:/.test(String(context.channelKey || ''))
      ? String(context.channelKey).slice('private:'.length)
      : String(context.userId || '')
    const groupId = String(params.groupId || context.groupId || contextGroupId || '').trim()
    const userId = String(params.userId || context.userId || contextUserId || '').trim()
    const name = String(params.name || '').trim() || undefined
    const displayName = name || path.basename(abs)
    if (!groupId && !userId) return `文件可发送：${displayName}。但缺少 groupId/userId，无法确定发送目标。`
    if (groupId && !/^\d+$/.test(groupId)) return 'groupId 必须为纯数字。'
    if (!groupId && userId && !/^\d+$/.test(userId)) return 'userId 必须为纯数字。'
    const action = groupId ? 'upload_group_file' : 'upload_private_file'
    const caller = typeof context.callOneBot === 'function' ? context.callOneBot : callOneBot
    const result = await caller(action, groupId ? { group_id: Number(groupId), file: abs, name } : { user_id: Number(userId), file: abs, name })
    if (!result.ok) return `文件未发送：${result.message || 'OneBot 不可用'}。文件名：${displayName}`
    return `已发送文件：${displayName}`
  },
  dangerous: true,
  defaultChannels: ['dashboard'],
}
