/** 独立数据根的真实文件存储夹具；只替换数据根和活动任务入口。 */
'use strict'
const assert = require('assert').strict
const fs = require('fs')
const os = require('os')
const path = require('path')
const management = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const storagePath = require.resolve('../../lib/report-storage')

// 枚举真实普通文件，用于验证磁盘字节、临时文件和去重。
function listPagedStoreFiles(root) {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name)
    return entry.isDirectory() ? listPagedStoreFiles(file) : [file]
  })
}

// 所有文件工具保留真实实现，活动任务、取消、租约和固定截止可精确控制。
async function withPagedStoreFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-paged-storage-'))
  const originalLoad = management.loadManagementModule, originalCache = require.cache[storagePath]
  const constants = originalLoad('core.constants'), tasks = originalLoad('resource.taskStore')
  const active = [], state = { now: 1000000, leased: true, alive: true }
  management.loadManagementModule = id => id === 'core.constants' ? { ...constants, DATA_DIR: root }
    : id === 'resource.taskStore' ? { ...tasks, listActiveDailyReportTasks: () => active } : originalLoad(id)
  delete require.cache[storagePath]
  const { PagedReportStore } = require(storagePath)
  // 每个新任务有独立截止，旧实例不能凭新任务工厂延长自身额度。
  const store = (id = 'task-A', group = 'group-A', timeoutMs = 600000) => new PagedReportStore({ taskId: id, channelKey: group,
    deadlineMs: state.now + timeoutMs, now: () => state.now,
    assertLease() { if (!state.leased) throw new Error('租约已失效') },
    assertActive() { if (!state.alive) throw new Error('任务已取消') } })
  try { await run({ root, active, state, store }) } finally {
    management.loadManagementModule = originalLoad
    if (originalCache) require.cache[storagePath] = originalCache; else delete require.cache[storagePath]
    const resolved = path.resolve(root)
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

module.exports = { withPagedStoreFixture, listPagedStoreFiles }
