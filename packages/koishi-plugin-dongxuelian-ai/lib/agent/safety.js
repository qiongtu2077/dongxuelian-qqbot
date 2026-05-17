/**
 * MODULE: 工具安全校验。
 * 职责: block/confirm/auto 三档判断 + 危险工具过滤 + 模式持久化。
 * 边界: 不执行工具。
 * 状态: mode (string)，启动时从文件加载。
 */
const { toolRegistry } = require('./tools/registry')
const { getDangerousPolicy } = require('./config')
const { TOOL_MODE_FILE } = require('../constants')
const fs = require('fs')
const fsp = require('fs/promises')

let mode = 'config'

// 启动时从文件加载
try { const v = fs.readFileSync(TOOL_MODE_FILE, 'utf8').trim(); if (['auto', 'confirm', 'block', 'config'].includes(v)) mode = v } catch {}

function getMode() { return mode }

async function setMode(m) {
  if (!['auto', 'confirm', 'block', 'config'].includes(m)) return
  mode = m
  try { await fsp.writeFile(TOOL_MODE_FILE, mode, 'utf8') } catch {}
}

const DANGEROUS_TOOLS = new Set(['execute_shell', 'write_file', 'edit_file', 'execute_javascript', 'browser_action', 'append_file'])

function getEffectivePolicy() {
  return mode === 'config' ? getDangerousPolicy() : mode
}

function check(toolName) {
  if (!toolRegistry[toolName]) return { allowed: false, error: `未知工具: ${toolName}` }
  if (!DANGEROUS_TOOLS.has(toolName)) return { allowed: true }
  const policy = getEffectivePolicy()
  if (policy === 'block') return { allowed: false, action: 'block', error: `工具 '${toolName}' 已被禁用（block 模式）` }
  if (policy === 'confirm') return { allowed: false, action: 'confirm', error: `工具 '${toolName}' 需要确认（confirm 模式）` }
  return { allowed: true, action: 'auto' }
}

module.exports = { getMode, setMode, getEffectivePolicy, check, DANGEROUS_TOOLS }
