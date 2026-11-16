/** 提供 SnowLuma 专用扫码桌面：静态 noVNC、一次性管理员票据与本机 VNC 桥接。 */
import fs = require('fs')
import path = require('path')
import http = require('http')
import net = require('net')
import crypto = require('crypto')
import auth = require('./auth')
import utils = require('./utils')
const { isRequestSiteTrusted } = auth
const { getRemoteAddress } = utils
import { protocolStatus, slRoot } from './protocol-runtime'
const { WebSocketServer, WebSocket } = require('ws') as typeof import('ws')
const prefix = '/dashboard/sl-desktop/'
const tickets = new Map<string, { ip: string; expires: number }>()

/** 签发 45 秒内可使用一次的票据，过期票据在签发和使用时清理。 */
export function desktopTicket(req: http.IncomingMessage): string {
  for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key)
  if (tickets.size >= 32) throw new Error('扫码桌面打开次数过多，请稍后重试')
  const ticket = crypto.randomBytes(32).toString('hex')
  tickets.set(ticket, { ip: getRemoteAddress(req), expires: Date.now() + 45000 })
  return ticket
}

/** 消费一次性票据，并校验来源、客户端和实际运行的协议。 */
async function authorizeDesktop(req: http.IncomingMessage, url: URL): Promise<boolean> {
  const key = url.searchParams.get('ticket') || ''
  const ticket = tickets.get(key)
  tickets.delete(key)
  if (!ticket || ticket.expires < Date.now() || ticket.ip !== getRemoteAddress(req) || !isRequestSiteTrusted(req)) return false
  const status = await protocolStatus()
  return status.selected === 'sl' && status.sl?.state === 'active' && !status.switching
}

/** 返回只连接当前项目的扫码桌面，供应商静态文件严格限制在 noVNC 根目录。 */
export function serveSlDesktop(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  if (!pathname.startsWith(prefix)) return false
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return true }
  if (pathname === prefix) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>SnowLuma 扫码桌面</title>
<style>html,body,#screen{margin:0;width:100%;height:100%;background:#111;color:#eee}#notice{position:absolute;z-index:2;padding:8px;background:#222}</style>
<div id="notice">正在连接 QQ 扫码桌面…</div><div id="screen"></div><script type="module">
import RFB from './vendor/core/rfb.js';
const url = new URL('socket', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
url.searchParams.set('ticket', new URLSearchParams(location.search).get('ticket') || '');
const rfb = new RFB(document.getElementById('screen'), url.href); rfb.scaleViewport = true;
rfb.addEventListener('connect', () => document.getElementById('notice').hidden = true);
rfb.addEventListener('disconnect', () => { const n = document.getElementById('notice'); n.hidden = false; n.textContent = '桌面连接已结束，请回到控制台重新打开'; });
history.replaceState(null, '', location.pathname);
window.addEventListener('pagehide', () => rfb.disconnect());
</script></html>`)
    return true
  }
  const root = process.env.SNOWLUMA_NOVNC_DIR || path.join(slRoot, 'novnc/usr/share/novnc')
  const relative = pathname.slice((prefix + 'vendor/').length)
  const target = path.resolve(root, relative)
  if (!pathname.startsWith(prefix + 'vendor/') || !target.startsWith(path.resolve(root) + path.sep)) {
    res.writeHead(404); res.end(); return true
  }
  try {
    if (!fs.statSync(target).isFile() || !['.js', '.css'].includes(path.extname(target))) throw new Error('missing asset')
    res.setHeader('Content-Type', path.extname(target) === '.js' ? 'application/javascript' : 'text/css')
    fs.createReadStream(target).on('error', () => res.destroy()).pipe(res)
  } catch { res.writeHead(404); res.end('noVNC 静态文件不存在') }
  return true
}

/** 安装管理员桌面 WebSocket 桥接，超时、错误、退出均释放 TCP 和定时器。 */
export function installSlDesktop(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      if (wss.clients.size >= 4 || url.pathname !== prefix + 'socket' || !await authorizeDesktop(req, url)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      wss.handleUpgrade(req, socket, head, ws => {
        const tcp = net.connect({ host: '127.0.0.1', port: 5909 })
        const deadline = setTimeout(() => ws.close(1000, '扫码会话已到期'), 15 * 60 * 1000)
        /** 两端统一回收，防止切换或页面关闭后保留后台连接。 */
        const cleanup = () => { clearTimeout(deadline); tcp.destroy(); ws.terminate() }
        tcp.setNoDelay(true)
        tcp.setTimeout(60000, cleanup)
        tcp.on('data', chunk => {
          if (ws.readyState !== WebSocket.OPEN) return cleanup()
          tcp.pause()
          ws.send(chunk, { binary: true }, error => { if (error) cleanup(); else tcp.resume() })
        })
        ws.on('message', (data, binary) => {
          if (!binary || !tcp.writable) return cleanup()
          if (!tcp.write(data as Buffer)) ws.pause()
        })
        tcp.on('drain', () => ws.resume())
        tcp.on('error', cleanup)
        tcp.on('close', cleanup)
        ws.on('error', cleanup)
        ws.on('close', cleanup)
      })
    } catch { socket.destroy() }
  })
  server.on('close', () => { for (const ws of wss.clients) ws.terminate(); wss.close(); tickets.clear() })
}
