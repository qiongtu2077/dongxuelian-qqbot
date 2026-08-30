'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const AI_ROOT = path.resolve(__dirname, '..')

// Builds a complete persisted resource task fixture for boundary validation.
function createResourceTaskFixture() {
  return {
    id: 'dto-task-1',
    kind: 'daily_report',
    status: 'pending',
    source: 'dto-test',
    channelKey: 'group-1',
    userId: 'user-1',
    priority: 50,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    expiresAt: '',
    timeoutMs: 300000,
    payload: {},
    notify: { target: 'none', status: 'pending' },
  }
}

// Builds a complete persisted media task fixture for boundary validation.
function createMediaTaskFixture() {
  return {
    id: 'media-task-1',
    kind: 'media_image_analysis',
    channelKey: 'group-1',
    messageId: 'message-1',
    urlHash: 'hash-1',
    url: 'https://example.invalid/image.png',
    fileId: null,
    createdAt: '2026-08-30T00:00:00.000Z',
    expiresAt: '2026-08-30T01:00:00.000Z',
    priority: 50,
    status: 'pending',
    payload: {},
  }
}

// Verifies that resource and media JSON enter trusted code only after DTO validation.
function assertRuntimeBoundaries() {
  const taskStore = require('../lib/resource-workers/task-store')
  const mediaQueue = require('../lib/media/backpressure/media-queue')
  const task = createResourceTaskFixture()
  const mediaTask = createMediaTaskFixture()

  assert.deepStrictEqual(taskStore._test.parseResourceTask(task), task)
  assert.strictEqual(taskStore._test.parseResourceTask({ ...task, status: 'mystery' }), null)
  assert.strictEqual(taskStore._test.parseResourceTask({ ...task, notify: null }), null)
  assert.deepStrictEqual(mediaQueue._test.parseMediaTask(mediaTask), mediaTask)
  assert.strictEqual(mediaQueue._test.parseMediaTask({ ...mediaTask, priority: '50' }), null)
  assert.strictEqual(mediaQueue._test.parseMediaTask({ ...mediaTask, payload: [] }), null)
}

// Verifies that the shared task DTO is exported and reused by trusted-domain modules.
function assertSharedDtoContract() {
  const read = relativePath => fs.readFileSync(path.join(AI_ROOT, relativePath), 'utf8')
  const typesSource = read('src/resource-workers/task-types.ts')
  assert(typesSource.includes('export interface ResourceTask'))
  assert(typesSource.includes('export interface ResourceWorkerState'))
  assert(!typesSource.includes('export = {}'))

  for (const relativePath of [
    'src/resource-workers/task-store.ts',
    'src/resource-workers/task-client.ts',
    'src/resource-workers/worker-supervisor.ts',
    'src/resource-workers/result-notifier.ts',
    'src/resource-workers/worker-main.ts',
  ]) {
    assert(read(relativePath).includes("import('./task-types').ResourceTask"), `${relativePath} must reuse ResourceTask`)
  }
  assert(!read('src/media/backpressure/media-queue.ts').includes('interface MediaTask extends Record<string, unknown>'))
  const agentPayloadSource = read('src/resource-workers/agent-payload.ts')
  assert(!agentPayloadSource.includes('engineInput?: Record<string, unknown>'))
  assert(!agentPayloadSource.includes('resumeInput?: Record<string, unknown>'))
}

// Runs DTO structure and runtime boundary regression checks.
function main() {
  assertRuntimeBoundaries()
  assertSharedDtoContract()
  console.log('DTO boundary tests passed')
}

main()
