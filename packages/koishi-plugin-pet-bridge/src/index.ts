/**
 * MODULE: pet-bridge plugin entry.
 * 职责: Start WebSocket server on port 9600 for desktop pet to connect.
 *        Delegates message handling to ./protocol.js.
 * 边界: Does NOT modify Koishi middleware, core plugin state, or conversation data.
 *        Only manages WS server lifecycle.
 */
const { WebSocketServer } = require('ws')
const { handleMessage } = require('./protocol') as typeof import('./protocol')

const name = 'pet-bridge'

interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

interface ContextLike {
  logger(name: string): LoggerLike
  on(event: 'ready' | 'dispose', handler: () => unknown): unknown
}

interface PluginConfig {
  port?: number
}

interface WebSocketLike {
  readyState: number
  send(data: string): void
  on(event: 'message', handler: (raw: Buffer | string) => unknown): unknown
  on(event: 'error', handler: (err: Error) => unknown): unknown
}

interface WebSocketServerLike {
  on(event: 'error', handler: (err: Error) => unknown): unknown
  on(event: 'connection', handler: (ws: WebSocketLike) => unknown): unknown
  close(callback: (err?: Error) => void): void
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function apply(ctx: ContextLike, config?: PluginConfig): void {
  const port = config?.port ?? 9600
  const logger = ctx.logger('pet-bridge')

  ctx.on('ready', () => {
    const wss = new WebSocketServer({ port, host: '127.0.0.1' }) as WebSocketServerLike
    let closed = false

    logger.info('pet-bridge: WS server listening on 127.0.0.1:' + port)

    wss.on('error', (err) => {
      logger.warn(`WS server error: ${err.message}`)
    })

    wss.on('connection', (ws) => {
      ws.on('message', async (raw) => {
        let msgId: unknown = null
        try {
          const parsed: unknown = JSON.parse(raw.toString())
          const msg = parsed && typeof parsed === 'object' ? parsed as { id?: unknown } : {}
          msgId = msg.id
          const response = await handleMessage(parsed)
          if (ws.readyState === 1) ws.send(JSON.stringify(response))
        } catch (err) {
          const message = getErrorMessage(err)
          logger.warn(`message error: ${message}`)
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'response', id: msgId, success: false, payload: { error: message } }))
          }
        }
      })

      ws.on('error', (err) => {
        logger.warn(`WS error: ${err.message}`)
      })
    })

    ctx.on('dispose', () => {
      if (closed) return
      closed = true
      wss.close((err) => {
        if (err) logger.warn(`WS close error: ${err.message}`)
        else logger.info('pet-bridge: server closed')
      })
    })
  })
}

export = { name, apply }
