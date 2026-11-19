/** SSH stream-local 转发的私有 HTTP 入口，独立于公网监听。 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync, type Stats } from 'node:fs'
import { createServer, type RequestListener } from 'node:http'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import paths = require('./paths')
import { markSshRequest, needsSshListener } from './trusted-access'

/** 为已经启用隧道模式的服务创建用户私有套接字。 */
export function startSshListener(handler: RequestListener) {
  if (process.platform === 'win32' || !needsSshListener()) return
  const directory = join(paths.DATA_DIR, 'dashboard-tunnel')
  const socket = join(directory, 'console.sock')
  let stale: Stats | undefined
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const dir = lstatSync(directory)
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)) throw new Error('入口目录权限无效')
    stale = lstatSync(socket, { throwIfNoEntry: false })
    if (stale && (!stale.isSocket() || stale.uid !== dir.uid)) throw new Error('入口路径已被其他文件占用')
  } catch (error) {
    console.error('[dashboard] SSH 私有入口停用', error instanceof Error ? error.message : '目录检查失败')
    return
  }
  const server = createServer((req, res) => {
    markSshRequest(req)
    handler(req, res)
  })
  server.on('error', (error: Error) => console.error('[dashboard] SSH 私有入口启动失败', error.message))
  // 异常退出会留下 socket 节点；只有探测为无监听者且身份未变化时才回收。
  const listen = () => server.listen(socket, () => {
    try { chmodSync(socket, 0o600) }
    catch { server.close(); console.error('[dashboard] SSH 私有入口权限设置失败') }
  })
  if (!stale) listen()
  else {
    const probe = createConnection(socket)
    probe.once('connect', () => { probe.end(); console.error('[dashboard] SSH 私有入口已在使用') })
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNREFUSED') return
      try {
        const current = lstatSync(socket, { throwIfNoEntry: false })
        if (current?.ino === stale.ino && current?.dev === stale.dev) { unlinkSync(socket); listen() }
      } catch { console.error('[dashboard] SSH 私有入口旧节点回收失败') }
    })
  }
  return server
}
