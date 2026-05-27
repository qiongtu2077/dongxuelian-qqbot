/**
 * MODULE: 工具安全校验。
 * 职责: block/confirm/auto 三档判断 + 危险工具过滤 + 模式持久化。
 * 边界: 不执行工具。
 * 状态: mode (string)，启动时从文件加载。
 */
const { toolRegistry } = require('./tools/registry') as typeof import('./tools/registry')
const { getDangerousPolicy } = require('./config') as typeof import('./config')
const { TOOL_MODE_FILE } = require('../core/constants') as typeof import('../core/constants')
const fs = require('fs')
const fsp = require('fs/promises')

type SafetyMode = 'auto' | 'confirm' | 'block' | 'config'
type EffectiveSafetyPolicy = Exclude<SafetyMode, 'config'>

interface SafetyCheckResult {
  allowed: boolean
  action?: EffectiveSafetyPolicy
  error?: string
}

let mode: SafetyMode = 'config'

function isSafetyMode(value: unknown): value is SafetyMode {
  return value === 'auto' || value === 'confirm' || value === 'block' || value === 'config'
}

// 启动时从文件加载
try { const v = fs.readFileSync(TOOL_MODE_FILE, 'utf8').trim(); if (isSafetyMode(v)) mode = v } catch { /* non-critical: missing tool mode file uses config policy */ }

function getMode(): SafetyMode { return mode }

async function setMode(m: unknown): Promise<void> {
  if (!isSafetyMode(m)) return
  mode = m
  try { await fsp.writeFile(TOOL_MODE_FILE, mode, 'utf8') } catch { /* non-critical: in-memory mode still applies if persistence fails */ }
}

const DANGEROUS_TOOLS: Set<string> = new Set(['execute_shell', 'write_file', 'edit_file', 'execute_javascript', 'browser_action', 'append_file'])

function getEffectivePolicy(): EffectiveSafetyPolicy {
  return mode === 'config' ? getDangerousPolicy() : mode
}

function check(toolName: unknown): SafetyCheckResult {
  const name = String(toolName || '')
  const tool = toolRegistry[name]
  if (!tool) return { allowed: false, error: `未知工具: ${toolName}` }
  if (!DANGEROUS_TOOLS.has(name) && !tool.dangerous) return { allowed: true }
  const policy = getEffectivePolicy()
  if (policy === 'block') return { allowed: false, action: 'block', error: `工具 '${toolName}' 已被禁用（block 模式）` }
  if (policy === 'confirm') return { allowed: false, action: 'confirm', error: `工具 '${toolName}' 需要确认（confirm 模式）` }
  return { allowed: true, action: 'auto' }
}

export = { getMode, setMode, getEffectivePolicy, check, DANGEROUS_TOOLS }
