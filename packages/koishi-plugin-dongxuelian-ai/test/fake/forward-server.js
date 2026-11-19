const { WebSocketServer } = require('ws')

// 用本机 OneBot 传输返回指定转发及原图文件，记录适配器实际读取的资源。
async function withForwardServer(records, imageFiles, run) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const previous = process.env.DONGXUELIAN_ONEBOT_WS_URL
  process.env.DONGXUELIAN_ONEBOT_WS_URL = `ws://127.0.0.1:${server.address().port}/onebot/v11/ws`
  const reads = [], forwards = []
  server.on('connection', socket => socket.on('message', raw => {
    const { action, params, echo } = JSON.parse(String(raw))
    let data
    if (action === 'get_forward_msg') {
      forwards.push(params.id)
      data = { messages: records }
    } else if (action === 'get_image') {
      reads.push(params.file)
      const file = imageFiles.get(params.file)
      if (file) data = { file }
    }
    socket.send(JSON.stringify({ status: data ? 'ok' : 'failed', retcode: data ? 0 : 1404, data, echo }))
  }))
  try {
    await run({ reads, forwards })
  } finally {
    if (previous === undefined) delete process.env.DONGXUELIAN_ONEBOT_WS_URL
    else process.env.DONGXUELIAN_ONEBOT_WS_URL = previous
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  }
}

module.exports = { withForwardServer }
