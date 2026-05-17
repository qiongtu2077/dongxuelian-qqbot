/**
 * MODULE: 向 QQ 用户/群发送文件工具。
 * 安全：限定路径白名单；OneBot 不可用时降级说明。
 */
const fs = require('fs/promises')
const WebSocket = require('ws')
const { assertExistingAgentPathInsideRoots } = require('../path-guard')

const MAX_SEND_FILE_BYTES = 64 * 1024 * 1024

function callOneBot(action, params, timeoutMs = 5000) {
  return new Promise(resolve => {
    let ws = null
    let timer = null
    let settled = false
    const echo = 'agent-send-file-' + Date.now()
    const finish = value => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { if (ws) ws.close() } catch {}
      resolve(value)
    }
    try {
      ws = new WebSocket('ws://127.0.0.1:8080/onebot/v11/ws')
      timer = setTimeout(() => finish({ ok: false, message: 'OneBot 连接超时' }), timeoutMs)
      ws.on('open', () => ws.send(JSON.stringify({ action, params, echo })))
      ws.on('message', raw => {
        try {
          const data = JSON.parse(String(raw))
          if (data.echo !== echo) return
          finish({ ok: data.status === 'ok' || data.retcode === 0, message: data.message || data.wording || '', data: data.data })
        } catch { finish({ ok: false, message: 'OneBot 响应解析失败' }) }
      })
      ws.on('error', err => finish({ ok: false, message: err.message || 'OneBot 不可用' }))
    } catch (e) { finish({ ok: false, message: e.message || 'OneBot 不可用' }) }
  })
}

module.exports = {
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
  async execute(params = {}) {
    const filePath = String(params.path || '').trim()
    if (!filePath) throw new Error('路径不能为空')
    const { abs } = await assertExistingAgentPathInsideRoots(filePath, '文件')
    const stat = await fs.stat(abs)
    if (!stat.isFile()) throw new Error(`不是文件：${filePath}`)
    if (stat.size > MAX_SEND_FILE_BYTES) throw new Error(`文件过大，拒绝通过 QQ 发送：${stat.size} bytes`)
    const groupId = String(params.groupId || '').trim()
    const userId = String(params.userId || '').trim()
    const name = String(params.name || '').trim() || undefined
    if (!groupId && !userId) return `文件可发送：${abs}。但缺少 groupId/userId，无法确定发送目标。`
    const action = groupId ? 'upload_group_file' : 'upload_private_file'
    const result = await callOneBot(action, groupId ? { group_id: Number(groupId), file: abs, name } : { user_id: Number(userId), file: abs, name })
    if (!result.ok) return `文件未发送：${result.message || 'OneBot 不可用'}。文件路径：${abs}`
    return `已发送文件：${abs}`
  },
  dangerous: false,
  defaultChannels: ['qq'],
}
