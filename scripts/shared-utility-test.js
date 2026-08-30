'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')

// 验证日报错误文本与有界整数工具保留合并前的边界语义。
function testDailyReportUtilities() {
  const errors = require('../packages/koishi-plugin-daily-report/lib/error-utils')
  const config = require('../packages/koishi-plugin-daily-report/lib/config-utils')
  assert.strictEqual(errors.getErrorMessage(new Error('daily failed')), 'daily failed')
  assert.strictEqual(errors.getErrorMessage(undefined), 'undefined')
  assert.strictEqual(errors.getErrorMessage(null, ''), '')
  assert.strictEqual(config.parseBoundedInt('12', 5, 1, 10), 10)
  assert.strictEqual(config.parseBoundedInt('bad', 5, 1, 10), 5)
}

// 验证 Dashboard 三种旧错误取值契约没有被机械合并成不同语义。
function testDashboardErrorUtilities() {
  const utils = require('../packages/koishi-plugin-dashboard/lib/utils')
  assert.strictEqual(utils.getErrorMessage({ message: 'dashboard failed' }), 'dashboard failed')
  assert.strictEqual(utils.getErrorMessage(null), '')
  const functionError = Object.assign(() => undefined, { message: 'function failure' })
  assert.strictEqual(utils.getObjectErrorMessage(functionError), undefined)
  assert.strictEqual(utils.getOptionalErrorMessage(functionError), 'function failure')
}

// 验证文件、图片和语音共享同一媒体键、历史路径及旧键迁移规则。
function testMediaStorageUtilities() {
  const storage = require('../packages/koishi-plugin-dongxuelian-ai/lib/media/storage-key')
  const historyDir = path.join('data', 'media-history')
  assert.strictEqual(storage.getSafeMediaStorageKey('group:1'), 'group_1')
  assert.strictEqual(storage.getLegacyUnsafeMediaStorageKey('group:1'), 'group:1')
  assert.strictEqual(storage.getMediaHistoryFilePath(historyDir, 'group:1'), path.join(historyDir, 'group_1.json'))
  assert.strictEqual(storage.getLegacyMediaHistoryFilePath(historyDir, 'group:1'), path.join(historyDir, 'group:1.json'))
  assert.strictEqual(storage.getLegacyMediaHistoryFilePath(historyDir, 'group 1'), '')
}

// 验证已确认的用户可见降级和次要状态写入均留下稳定提示或诊断代码。
function testObservabilityMarkers() {
  const read = relativePath => fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
  const agentPanel = read('packages/koishi-plugin-dashboard/frontend/src/components/AgentPanel.vue')
  for (const text of ['待确认工具加载失败', '会话历史加载失败', '会话详情加载失败']) assert(agentPanel.includes(text))

  const expectedMarkers = new Map([
    ['packages/koishi-plugin-dashboard/src/lib/deploy-state.ts', ['task_log_write_failed', 'pid_file_write_failed']],
    ['packages/koishi-plugin-dashboard/src/lib/routes/deploy.ts', ['stdout_log_write_failed', 'stderr_log_write_failed', 'activation_log_write_failed']],
    ['packages/koishi-plugin-dashboard/src/lib/routes/settings.ts', ['runtime_config_cache_reset_failed']],
    ['packages/koishi-plugin-dashboard/src/lib/routes/agent.ts', ['persona_voice_config_write_failed']],
    ['packages/koishi-plugin-daily-report/src/html-renderer.ts', ['render_cleanup_event_write_failed']],
    ['packages/koishi-plugin-dongxuelian-ai/src/core/api.ts', ['token_usage_persistence_failed']],
    ['packages/koishi-plugin-dongxuelian-ai/src/agent/safety.ts', ['tool_mode_persistence_failed']],
    ['packages/koishi-plugin-dongxuelian-ai/src/agent/push.ts', ['push_log_compaction_failed']],
    ['packages/koishi-plugin-dongxuelian-ai/src/agent/cron.ts', ['run_result_persistence_failed']],
    ['packages/koishi-plugin-dongxuelian-ai/src/media/voice/voice.ts', ['download_url_rejected', 'temp_voice_write_failed', 'network_setup_failed', 'conversion_fallback_failed', 'onebot_get_record_failed']],
    ['packages/koishi-plugin-dongxuelian-ai/src/media/image/image-analyzer.ts', ['onebot_get_image_failed']],
    ['packages/koishi-plugin-dongxuelian-ai/src/media/file/file-analyzer.ts', ['direct_download_failed', 'onebot_get_file_failed']],
  ])
  for (const [file, markers] of expectedMarkers) {
    const source = read(file)
    for (const marker of markers) assert(source.includes(marker), `${file} missing observability marker ${marker}`)
  }
}

// 运行共享工具与降级可观测性回归测试。
function main() {
  testDailyReportUtilities()
  testDashboardErrorUtilities()
  testMediaStorageUtilities()
  testObservabilityMarkers()
  console.log('Shared utility and observability tests passed')
}

main()
