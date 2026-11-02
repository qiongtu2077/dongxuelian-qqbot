'use strict'

const http = require('http') as typeof import('http')
const { execFile } = require('child_process') as typeof import('child_process')

// 完整读取 WebUI 页面，拒绝端口可连接但无 HTTP 响应的假健康状态。
function probeNapcatWebui(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/webui/', agent: false }, (response) => {
      let bytes = 0
      response.on('data', (chunk: Buffer) => { bytes += chunk.length })
      response.on('end', () => resolve(response.statusCode === 200 && bytes > 0))
      response.on('error', () => resolve(false))
    })
    request.setTimeout(1000, () => request.destroy(new Error('NapCat WebUI 请求超时')))
    request.on('error', () => resolve(false))
  })
}

// 等待新实例真正返回网页，启动失败时保留明确的失败结果。
async function waitForNapcatWebui(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  do {
    if (await probeNapcatWebui(port)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() < deadline)
  throw new Error(`NapCat WebUI 健康检查失败：127.0.0.1:${port} 未返回有效页面`)
}

// 交由 systemd 替换整个进程组，并在新实例通过健康检查后完成重启。
async function restartNapcatService(serviceName: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('systemctl', ['restart', serviceName], { timeout: 30000, maxBuffer: 512 * 1024 }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
  await waitForNapcatWebui(port)
}

export = { restartNapcatService, waitForNapcatWebui }
