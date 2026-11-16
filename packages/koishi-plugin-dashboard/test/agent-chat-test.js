'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { PassThrough } = require('stream')
const sharp = require('sharp')
const { createCapabilityConfig } = require('../../koishi-plugin-dongxuelian-ai/test/helpers/ai-capability-fixture')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-images-'))
process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
const auth = require('../lib/auth')
const agentRoutes = require('../lib/routes/agent')
const aiRoot = '../../koishi-plugin-dongxuelian-ai/lib/'
const submission = require(aiRoot + 'agent/worker-submission')
const taskStore = require(aiRoot + 'resource-workers/task-store')
const messages = require(aiRoot + 'agent/messages')
const payloads = require(aiRoot + 'resource-workers/agent-payload')
const redactor = require(aiRoot + 'core/redactor')
const originalSubmit = submission.submitAgentWorkerTask
const originalFetch = global.fetch
const queued = []
const modelCalls = []

// --- HTTP and isolated worker fixtures ---

/** Invokes the real Agent HTTP handler with admin authentication and a streamed JSON body. */
function callRoute(endpoint, body, admin = true) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough()
    req.headers = { 'x-admin-token': admin ? auth.createAdminToken() : '' }
    const res = {
      writeHead(status) { this.statusCode = status },
      end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }) },
    }
    try {
      agentRoutes.routes['POST /dashboard/api/agent/' + endpoint](req, res)
      req.end(JSON.stringify(body))
    } catch (error) { reject(error) }
  })
}

/** Persists the real payload while replacing resource admission, so tests never start a supervisor. */
function installWorkerFixture() {
  submission.submitAgentWorkerTask = options => {
    const task = taskStore.submitResourceTask({ ...options, kind: 'dashboard_agent', notify: { target: 'none' } })
    queued.push(task.id)
    return { accepted: true, taskId: task.id, status: 202, message: '后台处理中' }
  }
  fs.writeFileSync(path.join(dataDir, 'ai-capability-config.json'), JSON.stringify(createCapabilityConfig({
    text: [{ provider: 'openai', model: 'gpt-4o' }],
    vision: [{ provider: 'openai', model: 'gpt-4o-mini' }],
  })))
  fs.writeFileSync(path.join(dataDir, 'ai-openai-official-key.txt'), 'test-image-key')
  require(aiRoot + 'agent/auto-memory').onAgentReplyComplete = async () => {}
  global.fetch = async (_url, options) => {
    modelCalls.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'IMAGE_OK' } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
}

/** Re-reads a persisted task and executes the same standalone worker entry used in production. */
async function runQueuedTask(id) {
  const task = taskStore.getResourceTaskById(id)
  assert(task, 'large image task must remain readable after being written to disk')
  const result = await require(aiRoot + 'resource-workers/agent-worker').runAgentWorkerTask(task)
  assert.strictEqual(result.reply, 'IMAGE_OK')
  return task
}

// --- Multimodal chat and approval ---

/** Covers clipboard-sized payloads beyond both old truncation and JSON file-size limits. */
async function testImageWorkerChain(image) {
  const response = await callRoute('chat', { message: '', images: [image], agentMode: true })
  assert.strictEqual(response.status, 202)
  const task = await runQueuedTask(response.body.taskId)
  assert.deepStrictEqual(task.payload.agentWorker.engineInput.userImages, [image])
  const request = modelCalls.at(-1)
  assert.strictEqual(request.model, 'gpt-4o-mini', 'image chat must select the configured vision model')
  assert.strictEqual(request.messages.at(-1).content[1].image_url.url, image)
  assert(request.messages.at(-1).content[0].text.includes('请查看图片。'))

  const followup = await callRoute('chat', { message: '继续看这张图', history: [{ role: 'user', content: '图片', images: [image] }] })
  await runQueuedTask(followup.body.taskId)
  assert.strictEqual(modelCalls.at(-1).model, 'gpt-4o-mini')
  assert(modelCalls.at(-1).messages.some(item => Array.isArray(item.content) && item.content.some(part => part.image_url?.url === image)))

  const text = await callRoute('chat', { message: '纯文字' })
  await runQueuedTask(text.body.taskId)
  assert.strictEqual(modelCalls.at(-1).model, 'gpt-4o')
  assert.strictEqual(typeof modelCalls.at(-1).messages.at(-1).content, 'string')
  return request.messages
}

/** Verifies large image context survives persisted approvals and the nested resume worker payload. */
async function testApprovalImages(image, originalMessages) {
  let pending = require(aiRoot + 'agent/pending')
  const id = pending.setPendingTool('dashboard', 'dashboard', {
    toolName: 'calculate', args: { expression: '1+1' }, channel: 'dashboard',
    resume: {
      userMessage: '看图并计算', userName: 'Dashboard', toolCallId: 'image-tool-call', toolCount: 0,
      messages: [...originalMessages, { role: 'assistant', content: null, tool_calls: [{ id: 'image-tool-call', type: 'function', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } }] }],
    },
  })
  // Reload the stores and engine to prove the snapshot is read from disk rather than the old cache.
  for (const name of ['agent/pending', 'agent/engine', 'resource-workers/agent-worker']) delete require.cache[require.resolve(aiRoot + name)]
  pending = require(aiRoot + 'agent/pending')
  const snapshot = pending.findPendingToolById(id)
  assert(snapshot, 'approval snapshot above 2 MB must remain readable')
  assert.strictEqual(snapshot.resume.messages.at(-2).content[1].image_url.url, image)
  const confirmed = await callRoute('confirm', { pendingId: id })
  assert.strictEqual(confirmed.status, 202)
  const task = await runQueuedTask(confirmed.body.taskId)
  assert.strictEqual(task.payload.agentWorker.pendingSnapshot.resume.messages.at(-2).content[1].image_url.url, image)
  assert.strictEqual(modelCalls.at(-1).model, 'gpt-4o-mini')
  assert(modelCalls.at(-1).messages.some(item => Array.isArray(item.content) && item.content.some(part => part.image_url?.url === image)))
}

/** Rejects malformed/oversized images before queue submission, retaining auth and text behavior. */
async function testRejectedInputs(image) {
  const count = queued.length
  const smallImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
  const invalid = [
    { images: 'not-an-array' },
    { images: ['https://example.invalid/image.png'] },
    { images: ['data:image/svg+xml;base64,PHN2Zz4='] },
    { images: ['data:image/png;base64,AAAA'] },
    { images: Array(5).fill(smallImage) },
    { images: [image, image] },
    {},
  ]
  for (const body of invalid) assert.strictEqual((await callRoute('chat', body)).status, 400)
  assert.strictEqual((await callRoute('chat', { images: [image] }, false)).status, 403)
  assert.strictEqual(queued.length, count, 'rejected input must never enter the worker queue')
  const budgeted = messages.sanitizeAgentHistory([{ role: 'user', content: 'old image', images: [image] }], [image])
  assert.strictEqual(budgeted[0].images, undefined)
  assert(budgeted[0].content.includes('历史图片未附带'))
  assert.deepStrictEqual(messages.sanitizeAgentHistory([{ role: 'system', content: 'untrusted' }]), [])
}

/** Ensures binary strings resembling credential assignments are preserved while text secrets are redacted. */
function testImageRedaction() {
  const data = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), Buffer.from('tokenA==', 'base64')])
  const url = 'data:image/png;base64,' + data.toString('base64')
  assert(url.endsWith('tokenA=='))
  assert.strictEqual(redactor.redactSensitiveText(url), url)
  assert.strictEqual(payloads.toJsonSafe(url), url)
  assert.strictEqual(redactor.redactSensitiveData({ password: 'secret', image: url }).password, '[redacted]')
  assert.strictEqual(redactor.redactSensitiveText('token=secret'), 'token=[redacted]')
  assert(payloads.toJsonSafe('x'.repeat(21000)).endsWith('[truncated]'))
  assert.strictEqual(payloads.toJsonSafe('data:image/png;base64,文字说明'), 'data:image/png;base64,文字说明')
}

/** Runs the authenticated HTTP-to-disk-to-worker-to-model image regression chain using isolated data. */
async function main() {
  try {
    installWorkerFixture()
    const png = await sharp(crypto.randomBytes(1024 * 768 * 3), { raw: { width: 1024, height: 768, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
    const image = 'data:image/png;base64,' + png.toString('base64')
    assert(Buffer.byteLength(image) > 2 * 1024 * 1024)
    testImageRedaction()
    const originalMessages = await testImageWorkerChain(image)
    await testApprovalImages(image, originalMessages)
    await testRejectedInputs(image)
    console.log('Agent image chat route/worker/model/approval tests passed')
  } finally {
    submission.submitAgentWorkerTask = originalSubmit
    global.fetch = originalFetch
    require(aiRoot + 'core/api').flushTokenUsage()
    assert.strictEqual(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
