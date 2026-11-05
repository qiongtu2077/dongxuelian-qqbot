/** 真实图片下载器边界测试：模拟流式 HTTP，验证未知/伪造长度及本地读取。 */
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')
const { EventEmitter } = require('events')

// 模拟响应流并记录断开时机，不连接任何外部地址。
function installImageResponse(headers, chunks) {
  const state = { consumed: 0, disconnected: false }
  https.get = (url, options, callback) => {
    const request = new EventEmitter()
    const response = new EventEmitter()
    response.statusCode = 200
    response.headers = headers
    response.resume = () => {}
    response.destroy = () => { state.disconnected = true }
    request.destroy = () => { state.disconnected = true; request.emit('error', new Error('stream_closed')) }
    const abort = () => request.destroy()
    options.signal?.addEventListener('abort', abort, { once: true })
    setImmediate(() => {
      if (options.signal?.aborted) { abort(); return }
      callback(response)
      for (const chunk of chunks) {
        if (state.disconnected) break
        state.consumed += chunk.length
        response.emit('data', chunk)
      }
      if (!state.disconnected) response.emit('end')
      options.signal?.removeEventListener('abort', abort)
    })
    return request
  }
  return state
}

// 直接调用生产 API，检查消费字节、断开连接及是否编码超限原图。
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-download-'))
  process.env.DONGXUELIAN_AI_DATA_DIR = dir
  const lib = path.resolve(__dirname, '../lib')
  const utils = require(path.join(lib, 'core/utils'))
  utils.resolveAndValidateHostname = async () => {}
  const api = require(path.join(lib, 'core/api'))
  const { MAX_IMAGE_BYTES } = require(path.join(lib, 'core/constants'))
  const originalGet = https.get
  const originalStream = fs.createReadStream
  const small = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
  const exact = Buffer.alloc(MAX_IMAGE_BYTES); small.copy(exact)
  let checks = 0
  // 不输出图片字节或完整 URL。
  const check = (label, condition) => { assert.ok(condition, label); checks++; console.log('OK ' + label) }
  try {
    let reason = ''
    let state = installImageResponse({ 'content-length': String(MAX_IMAGE_BYTES + 1) }, [exact])
    check('声明超限不消费响应原图并断开连接', !await api.downloadImageAsBase64('https://media.example.test/image', 1000, value => { reason = value }) && state.consumed === 0 && state.disconnected && reason === 'image_too_large')
    state = installImageResponse({}, [exact, Buffer.from([1]), small])
    check('未知大小在首次超过十兆时终止，不消费后续块', !await api.downloadImageAsBase64('https://media.example.test/image', 1000) && state.disconnected && state.consumed === MAX_IMAGE_BYTES + 1)
    state = installImageResponse({ 'content-length': '1' }, [exact, Buffer.from([1])])
    check('伪造小长度不能绕过实际字节累计', !await api.downloadImageAsBase64('https://media.example.test/image', 1000) && state.disconnected)
    state = installImageResponse({ 'content-length': String(MAX_IMAGE_BYTES), 'content-type': 'application/octet-stream' }, [exact])
    const accepted = await api.downloadImageAsBase64('https://media.example.test/no-extension', 1000)
    check('恰好十兆不因声明类型或无后缀被提前拒绝', !!accepted && !state.disconnected && Buffer.from(accepted.split(',')[1], 'base64').length === MAX_IMAGE_BYTES)
    installImageResponse({ 'content-type': 'text/plain' }, [small])
    check('图片内容优先于错误的响应类型声明', (await api.downloadImageAsBase64('https://media.example.test/image', 1000))?.startsWith('data:image/png;base64,'))
    installImageResponse({ 'content-type': 'image/png' }, [Buffer.from('not an image')])
    reason = ''
    check('图片响应声明不能放行伪装文本', !await api.downloadImageAsBase64('https://media.example.test/image', 1000, value => { reason = value }) && reason === 'image_invalid')
    const local = path.join(dir, 'local.png')
    fs.writeFileSync(local, exact)
    check('本地恰好十兆允许编码', !!await api.readImageAsBase64(local))
    fs.appendFileSync(local, Buffer.from([1]))
    check('本地超限先于流式读取拒绝', !await api.readImageAsBase64(local))
    fs.writeFileSync(local, small)
    fs.createReadStream = (file, options) => { fs.appendFileSync(file, exact); return originalStream(file, options) }
    check('本地文件在大小检查后增长仍受实际读取边界约束', !await api.readImageAsBase64(local))
    fs.createReadStream = originalStream
    const cancelled = new AbortController(); cancelled.abort()
    state = installImageResponse({}, [small])
    check('取消连接不消费原图', !await api.downloadImageAsBase64('https://media.example.test/image', 1000, undefined, cancelled.signal) && state.consumed === 0 && state.disconnected)
    check('已取消的文件编号查询不创建OneBot请求', await api.callGetFile('cancelled-file', cancelled.signal) === null && await api.callGetImage('cancelled-image', cancelled.signal) === null)
    console.log(JSON.stringify({ checks }))
  } finally { https.get = originalGet; fs.createReadStream = originalStream; fs.rmSync(dir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
