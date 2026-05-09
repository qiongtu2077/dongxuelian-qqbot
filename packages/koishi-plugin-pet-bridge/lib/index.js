/**
 * MODULE: pet-bridge plugin entry.
 * 职责: Start WebSocket server on port 9600 for desktop pet to connect.
 *        Delegates message handling to ./protocol.js.
 * 边界: Does NOT modify Koishi middleware, core plugin state, or conversation data.
 *        Only manages WS server lifecycle.
 */
const { WebSocketServer } = require('ws')
const { handleMessage } = require('./protocol')

exports.name = 'pet-bridge'

exports.apply = (ctx, config) => {
  const port = (config && config.port) || 9600
  const logger = ctx.logger('pet-bridge')

  ctx.on('ready', () => {
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })

    logger.info('pet-bridge: WS server listening on 127.0.0.1:' + port)

    wss.on('connection', (ws) => {
      ws.on('message', async (raw) => {
        let msgId = null
        try {
          const msg = JSON.parse(raw.toString())
          msgId = msg.id
          const response = await handleMessage(msg)
          if (ws.readyState === 1) ws.send(JSON.stringify(response))
        } catch (err) {
          logger.warn(`message error: ${err.message}`)
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'response', id: msgId, success: false, payload: { error: err.message } }))
          }
        }
      })

      ws.on('error', (err) => {
        logger.warn(`WS error: ${err.message}`)
      })
    })

    ctx.on('dispose', () => {
      wss.close()
      logger.info('pet-bridge: server closed')
    })
  })
}
