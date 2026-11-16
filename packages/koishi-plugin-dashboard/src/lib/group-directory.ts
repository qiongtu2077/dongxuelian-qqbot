/** 从当前项目的本机 OneBot 获取真实群名，认证信息只留在服务端。 */
import { randomUUID } from 'crypto'
import { WebSocket } from 'ws'
import { readOnebotTarget } from './snowluma-client'

// 查询群目录，并在成功、错误、断开或超时时释放连接和定时器。
export function readGroupNames(): Promise<Record<string, string>> {
  const { endpoint, token } = readOnebotTarget()
  return new Promise((resolve, reject) => {
    const echo = randomUUID()
    const socket = new WebSocket(endpoint, { headers: token ? { Authorization: `Bearer ${token}` } : {}, maxPayload: 2 * 1024 * 1024 })
    let settled = false
    const timer = setTimeout(() => finish(new Error('群名称读取超时，请检查 QQ 连接状态')), 5000)

    // 每条退出路径只结算一次；终止连接也覆盖握手尚未完成的情况。
    function finish(error: Error | null, groups: Record<string, string> = {}): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.terminate()
      if (error) reject(error)
      else resolve(groups)
    }

    socket.on('open', () => socket.send(JSON.stringify({ action: 'get_group_list', params: {}, echo })))
    socket.on('message', raw => {
      try {
        const response = JSON.parse(raw.toString()) as { echo?: string; status?: string; retcode?: number; data?: Array<{ group_id: number; group_name: string }> }
        if (response.echo !== echo) return
        if (response.status !== 'ok' || response.retcode !== 0 || !Array.isArray(response.data)) throw new Error('群列表接口未返回有效结果')
        const groups: Record<string, string> = {}
        for (const group of response.data) {
          if (!/^[1-9]\d{0,19}$/.test(String(group.group_id)) || typeof group.group_name !== 'string') throw new Error('群列表中的群号或群名称无效')
          groups[String(group.group_id)] = group.group_name
        }
        finish(null, groups)
      } catch { finish(new Error('群名称读取失败，请检查 QQ 连接状态')) }
    })
    socket.on('error', () => finish(new Error('群名称读取失败，请检查 QQ 连接状态')))
    socket.on('close', () => finish(new Error('群名称连接已断开，请检查 QQ 连接状态')))
  })
}
