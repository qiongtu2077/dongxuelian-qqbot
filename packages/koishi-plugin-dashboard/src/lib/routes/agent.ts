'use strict'

import type { IncomingMessage, ServerResponse } from 'http'

const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { json, collectBody, parsePositiveInt } = require('../utils') as typeof import('../utils')
const { requireAdmin } = require('../auth') as typeof import('../auth')
const { AI_LIB, DATA_DIR } = require('../paths') as typeof import('../paths')
const { isAgentPathInside } = require('../paths') as typeof import('../paths')

const MAX_DOWNLOAD_BYTES = parsePositiveInt(process.env.DASHBOARD_MAX_DOWNLOAD_BYTES, 256 * 1024 * 1024, 8 * 1024 * 1024, 2 * 1024 * 1024 * 1024)
const MAX_AGENT_PREVIEW_FILE_BYTES = parsePositiveInt(process.env.DASHBOARD_AGENT_PREVIEW_MAX_BYTES, 512 * 1024, 64 * 1024, 2 * 1024 * 1024)
const MAX_TTS_CLONE_AUDIO_BYTES = parsePositiveInt(process.env.DASHBOARD_TTS_CLONE_AUDIO_MAX_BYTES, 7 * 1024 * 1024, 1024, 10 * 1024 * 1024)

interface AgentWorkspaceListOptions {
  root?: string
  query?: string
  limit?: string | number
}

type AgentPathGuardModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/path-guard')
type ExistingAgentPath = Awaited<ReturnType<AgentPathGuardModule['assertExistingAgentPathInsideRoots']>>
type NewAgentPath = Awaited<ReturnType<AgentPathGuardModule['assertNewAgentPathInsideRoots']>>

type AgentWorkspaceFileType = 'dir' | 'file' | 'other'

interface AgentWorkspaceFileItem {
  path: string
  rel: string
  name: string
  type: AgentWorkspaceFileType
  size: number
  mtimeMs: number
  injectable: boolean
}

interface AgentWorkspaceListResult {
  root: string
  files: AgentWorkspaceFileItem[]
}

interface AgentFilePreview {
  path: string
  name: string
  size: number
  mtimeMs: number
  binary: boolean
  truncated: boolean
  content: string
}

interface AgentEnvFileStatus {
  name: string
  exists: boolean
  configured: boolean
  size: number
}

interface AgentTaskResult extends Record<string, unknown> {
  ok?: unknown
  reply?: unknown
  message?: unknown
  error?: unknown
  pendingId?: unknown
  toolCalls?: unknown
  warnings?: unknown
}

type AgentConfigModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/config')
type AgentRegistryModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/tools/registry')
type AgentSafetyModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/safety')
type AgentStatsModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/stats')
type AgentQueueModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/queue')
type AgentSkillsModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/skills')
type AgentPersonaContextModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/persona-context')
type TtsModule = typeof import('koishi-plugin-dongxuelian-ai/lib/media/voice/tts')
type TtsResourceModule = typeof import('koishi-plugin-dongxuelian-ai/lib/media/voice/tts-resource')
type VoiceAssetsModule = typeof import('koishi-plugin-dongxuelian-ai/lib/media/voice/voice-assets')
type PersonaModule = typeof import('koishi-plugin-dongxuelian-ai/lib/persona/persona')
type RuntimeConfigModule = typeof import('koishi-plugin-dongxuelian-ai/lib/core/runtime-config')
type ShellGuardModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/tools/shell-guard')
type AgentPushModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/push')
type AgentSessionModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/sessions')
type AgentPlanStoreModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/plan/plan-store')
type AgentPlanEngineModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/plan/plan-engine')
type AgentCronModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/cron')
type AgentWorkerSubmissionModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/worker-submission')
type AgentWorkerPayloadModule = typeof import('koishi-plugin-dongxuelian-ai/lib/resource-workers/agent-payload')
type AgentMessagesModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/messages')
type AgentRouterModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/router')
type AgentPendingModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/pending')
type AgentTaskStoreModule = typeof import('koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
type AgentPlanRunnerModule = typeof import('koishi-plugin-dongxuelian-ai/lib/agent/plan/plan-runner')
type TtsOptions = NonNullable<Parameters<TtsModule['synthesizeSpeech']>[1]>
type VoiceDiagnostics = NonNullable<TtsOptions['diagnostics']>
type AgentConfigPatch = NonNullable<Parameters<AgentConfigModule['patchAgentConfig']>[0]>
type AgentCreatePlanOptions = NonNullable<Parameters<AgentPlanEngineModule['createPlan']>[0]>
type AgentCronCreateBody = Parameters<AgentCronModule['registerCron']>[0]
interface DashboardPendingTool extends Record<string, unknown> {
  id: string
  toolName: string
  userId: string
  channelKey: string
  channel: string
}
type DashboardPendingToolSnapshot = Record<string, unknown>

type AgentConfigPutBody = AgentConfigPatch & {
  config?: AgentConfigPatch
  mode?: unknown
}

interface AgentPersonaPutBody extends Record<string, unknown> {
  dashboardPersona?: unknown
  qqInheritChatPersona?: unknown
}

interface TtsLogger {
  warn(message: string): void
}

interface TtsResourceBusyResult {
  decision?: unknown
  reason?: unknown
  resourceState?: unknown
  botMode?: unknown
}

interface PersonaVoiceConfigEntry {
  name: string
  voice: string
  voiceAssetId: string
  style: string
  hasSample: boolean
}

interface PersonaSkillFile {
  file: string
  content: string
}

interface TtsCloneBody extends Record<string, unknown> {
  personaName?: unknown
  audioBase64?: unknown
  mimeType?: unknown
  displayName?: unknown
  description?: unknown
  sampleText?: unknown
  voiceStyle?: unknown
}

interface TtsPreviewBody extends Record<string, unknown> {
  text?: unknown
  voice?: unknown
  style?: unknown
  personaName?: unknown
  persona?: unknown
  voiceAssetId?: unknown
}

interface TtsCloneRenameBody extends Record<string, unknown> {
  id?: unknown
  oldName?: unknown
  name?: unknown
  displayName?: unknown
  newName?: unknown
  description?: unknown
  sampleText?: unknown
}

interface TtsCloneDeleteBody extends Record<string, unknown> {
  id?: unknown
  name?: unknown
  force?: unknown
}

interface PersonaVoicePutBody extends Record<string, unknown> {
  personaName?: unknown
  voiceId?: unknown
  voiceStyle?: unknown
  voiceAssetId?: unknown
}

interface AgentFileUploadBody extends Record<string, unknown> {
  root?: unknown
  name?: unknown
  content?: unknown
}

interface AgentPlanCreateBody extends Record<string, unknown> {
  goal?: unknown
  title?: unknown
  tasks?: unknown
  userId?: unknown
  userName?: unknown
}

interface AgentChatBody extends Record<string, unknown> {
  message?: unknown
  userName?: unknown
  userId?: unknown
  history?: unknown
  enableThinking?: unknown
  agentMode?: unknown
}

interface AgentConfirmBody extends Record<string, unknown> {
  pendingId?: unknown
}

interface AgentRejectBody extends Record<string, unknown> {
  pendingId?: unknown
}

interface AgentPlanResumeBody extends Record<string, unknown> {
  userId?: unknown
  userName?: unknown
}

interface AgentPlanAbandonBody extends Record<string, unknown> {
  reason?: unknown
}

type AgentRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL
) => void | Promise<void>

type AgentRegexRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpMatchArray,
  pathname: string,
  url: URL
) => void | Promise<void>

interface AgentRegexRoute {
  pattern: RegExp
  method: string
  handler: AgentRegexRouteHandler
}

interface DashboardAgentTask {
  id?: unknown
  kind?: unknown
  status?: unknown
  source?: unknown
  channelKey?: unknown
  userId?: unknown
  step?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  startedAt?: unknown
  finishedAt?: unknown
  error?: unknown
  notify?: unknown
}

async function resolveAgentWorkspacePath(target: unknown): Promise<ExistingAgentPath> {
  const guard = require(path.join(AI_LIB, 'agent', 'path-guard')) as AgentPathGuardModule
  return guard.assertExistingAgentPathInsideRoots(String(target || ''), '路径')
}

async function resolveAgentUploadTarget(root: unknown, name: unknown): Promise<NewAgentPath> {
  const guard = require(path.join(AI_LIB, 'agent', 'path-guard')) as AgentPathGuardModule
  const base = String(root || '').trim() || await guard.resolveAgentDefaultRoot()
  const safeName = path.basename(String(name || '').replace(/[\\/:*?"<>|]+/g, '_')).slice(0, 160)
  if (!safeName) throw new Error('文件名不能为空')
  const target = path.join(base, safeName)
  return guard.assertNewAgentPathInsideRoots(target, '上传文件', true)
}

async function listAgentWorkspaceFiles({ root, query = '', limit = 120 }: AgentWorkspaceListOptions = {}): Promise<AgentWorkspaceListResult> {
  const guard = require(path.join(AI_LIB, 'agent', 'path-guard')) as AgentPathGuardModule
  const base = root ? String(root) : await guard.resolveAgentDefaultRoot()
  const { abs } = await guard.assertExistingAgentPathInsideRoots(base, '目录')
  const stat = await fs.promises.stat(abs)
  if (!stat.isDirectory()) throw new Error('不是目录：' + abs)
  const max = Math.max(1, Math.min(300, parseInt(String(limit), 10) || 120))
  const needle = String(query || '').trim().toLowerCase()
  const ignored = new Set(['.git', 'node_modules', 'dist', 'dist-portable', 'tmp'])
  const items: AgentWorkspaceFileItem[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (items.length >= max || depth > 4) return
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (items.length >= max) return
      if (entry.isDirectory() && ignored.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (!isAgentPathInside(full, abs)) continue
      const rel = path.relative(abs, full) || entry.name
      const matches = !needle || rel.toLowerCase().includes(needle)
      let itemStat = null
      if (matches) itemStat = await fs.promises.stat(full).catch(() => null)
      if (matches && itemStat) {
        items.push({
          path: full, rel, name: entry.name,
          type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
          size: itemStat.size, mtimeMs: itemStat.mtimeMs,
          injectable: entry.isFile() && itemStat.size <= MAX_AGENT_PREVIEW_FILE_BYTES,
        })
      }
      if (entry.isDirectory()) await walk(full, depth + 1)
    }
  }
  await walk(abs, 0)
  return { root: abs, files: items }
}

async function previewAgentWorkspaceFile(target: unknown): Promise<AgentFilePreview> {
  const { abs } = await resolveAgentWorkspacePath(target)
  const stat = await fs.promises.stat(abs)
  if (!stat.isFile()) throw new Error('不是文件：' + abs)
  const meta = { path: abs, name: path.basename(abs), size: stat.size, mtimeMs: stat.mtimeMs, binary: false, truncated: false, content: '' }
  if (stat.size > MAX_AGENT_PREVIEW_FILE_BYTES) { meta.truncated = true; return meta }
  const buffer = await fs.promises.readFile(abs)
  if (buffer.includes(0)) { meta.binary = true; return meta }
  const content = buffer.toString('utf8')
  meta.truncated = content.length > 12000
  meta.content = content.slice(0, 12000)
  return meta
}

async function getAgentEffectiveReadRoots(): Promise<string[]> {
  const guard = require(path.join(AI_LIB, 'agent', 'path-guard')) as AgentPathGuardModule
  return guard.getAgentPathAllowedRoots()
}

function getAgentEnvStatus(): AgentEnvFileStatus[] {
  const constants = require(path.join(AI_LIB, 'core', 'constants')) as typeof import('koishi-plugin-dongxuelian-ai/lib/core/constants')
  const files: Array<[string, string]> = [
    ['ai-openai-key.txt', constants.KEY_FILE],
    ['ai-deepseek-key.txt', constants.DEEPSEEK_KEY_FILE],
    ['ai-dashscope-key.txt', constants.DASHSCOPE_KEY_FILE],
    ['ai-glm-key.txt', constants.GLM_KEY_FILE],
    ['ai-mimorium-key.txt', constants.MIMORIUM_KEY_FILE],
    ['ai-provider.txt', constants.PROVIDER_FILE],
    ['ai-model.txt', constants.MODEL_FILE],
    ['ai-base-url.txt', constants.BASE_URL_FILE],
    ['ai-enable-search.txt', constants.SEARCH_ENABLED_FILE],
  ]
  return files.map(([name, file]) => {
    const exists = fs.existsSync(file)
    let size = 0, configured = false
    try {
      const stat = fs.statSync(file)
      size = stat.size
      configured = stat.size > 0 && String(fs.readFileSync(file, 'utf8')).trim().length > 0
    } catch { /* non-critical: optional env file probe */ }
    return { name, exists, configured, size }
  })
}

function readAgentTaskResult(taskId: unknown): AgentTaskResult {
  try {
    return (require(path.join(AI_LIB, 'resource-workers', 'result-notifier')) as typeof import('koishi-plugin-dongxuelian-ai/lib/resource-workers/result-notifier')).readTaskResult(String(taskId || ''))
  } catch {
    return {}
  }
}

function sanitizeAgentTaskForDashboard(task: DashboardAgentTask | null | undefined, result: AgentTaskResult = {}) {
  if (!task) return null
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    source: task.source,
    channelKey: task.channelKey,
    userId: task.userId,
    step: task.step,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
    notify: task.notify,
    result: {
      ok: result.ok,
      reply: result.reply || '',
      message: result.message || '',
      error: result.error || '',
      pendingId: result.pendingId || null,
      toolCalls: result.toolCalls || 0,
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
    },
  }
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message || '')
  return String(error || '')
}

function getLegacyErrorMessage(error: unknown): unknown {
  return (error as { message?: unknown } | null | undefined)?.message
}

function toDashboardPendingSnapshot(value: unknown): DashboardPendingToolSnapshot | null {
  if (!value || typeof value !== 'object') return null
  return value as DashboardPendingToolSnapshot
}

function toObjectSpreadSource(value: unknown): object {
  return value == null ? {} : Object(value)
}

// --- Route Handlers ---

async function handleGetAgentConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return
  try {
    const agentConfig = (require(path.join(AI_LIB, 'agent', 'config')) as AgentConfigModule).getAgentConfig(true)
    const registry = require(path.join(AI_LIB, 'agent', 'tools', 'registry')) as AgentRegistryModule
    const safety = require(path.join(AI_LIB, 'agent', 'safety')) as AgentSafetyModule
    const stats = (require(path.join(AI_LIB, 'agent', 'stats')) as AgentStatsModule).getStats()
    const skills = (require(path.join(AI_LIB, 'agent', 'skills')) as AgentSkillsModule).listAgentSkills()
    const personas = (require(path.join(AI_LIB, 'agent', 'persona-context')) as AgentPersonaContextModule).listAgentPersonasForConsole()
    const effectiveReadRoots = await getAgentEffectiveReadRoots()
    const qqEnabledTools = new Set(registry.getToolDefinitions('qq').map(item => item.function.name))
    const dashboardEnabledTools = new Set(registry.getToolDefinitions('dashboard').map(item => item.function.name))
    const tools = registry.getToolSummaries().map(tool => ({
      ...tool, qqEnabled: qqEnabledTools.has(tool.name), dashboardEnabled: dashboardEnabledTools.has(tool.name),
    }))
    return json(res, { ok: true, config: agentConfig, mode: safety.getMode(), stats, tools, skills, personas, effectiveReadRoots })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
}

async function handlePutAgentConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, async (body) => {
    try {
      const data = JSON.parse(body || '{}') as AgentConfigPutBody
      const agentConfig = require(path.join(AI_LIB, 'agent', 'config')) as AgentConfigModule
      const safety = require(path.join(AI_LIB, 'agent', 'safety')) as AgentSafetyModule
      // L43: AgentPanel 只提交可见字段，必须用 patch/merge 保留未提交的 queue/cron/memory/planMode/push，
      // 否则保存工具开关或 MCP 时会把这些隐藏高级配置静默重置为默认值。
      const saved = await agentConfig.patchAgentConfig(data.config || data)
      if (data.mode) await safety.setMode(data.mode)
      return json(res, { ok: true, config: saved, mode: safety.getMode(), message: 'Agent 配置已更新' })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handleGetAgentPersonas(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    const agentConfig = (require(path.join(AI_LIB, 'agent', 'config')) as AgentConfigModule).getAgentConfig(true)
    const personas = (require(path.join(AI_LIB, 'agent', 'persona-context')) as AgentPersonaContextModule).listAgentPersonasForConsole()
    return json(res, { ok: true, personas, persona: agentConfig.persona || { dashboardPersona: '', qqInheritChatPersona: true } })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
}

function handlePutAgentPersona(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, async (body) => {
    try {
      const data = JSON.parse(body || '{}') as AgentPersonaPutBody
      const agentConfig = require(path.join(AI_LIB, 'agent', 'config')) as AgentConfigModule
      const current = agentConfig.getAgentConfig()
      const personaName = String(data.dashboardPersona || '').trim()
      const personas = (require(path.join(AI_LIB, 'agent', 'persona-context')) as AgentPersonaContextModule).listAgentPersonasForConsole()
      if (personaName && !personas.some(item => item.name === personaName)) return json(res, { ok: false, message: '未知人格：' + personaName }, 400)
      current.persona = {
        dashboardPersona: personaName,
        qqInheritChatPersona: data.qqInheritChatPersona === undefined ? current.persona?.qqInheritChatPersona !== false : !!data.qqInheritChatPersona,
      }
      const saved = await agentConfig.saveAgentConfig(current)
      return json(res, { ok: true, persona: saved.persona, message: 'Agent 人格已更新' })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function getTtsModule(): TtsModule {
  return require(path.join(AI_LIB, 'media', 'voice', 'tts')) as TtsModule
}

// 读取 AI 插件中的 TTS 资源门控模块，Dashboard 侧跨进程复用同一 S0/S1 状态。
function getTtsResourceModule(): TtsResourceModule {
  return require(path.join(AI_LIB, 'media', 'voice', 'tts-resource')) as TtsResourceModule
}

function getTtsLogger(): TtsLogger {
  return {
    warn(message: string): void {
      console.warn(`[dashboard] ${message}`)
    },
  }
}

// 将 TTS 资源门控拒绝结果转成 Dashboard API 的结构化低成本响应。
function buildTtsResourceBusyPayload(result: TtsResourceBusyResult | null | undefined) {
  return {
    ok: false,
    message: '当前资源正忙，语音合成稍后再试',
    code: 'RESOURCE_BUSY',
    decision: result?.decision || 'reject',
    reason: result?.reason || '',
    resourceState: result?.resourceState || '',
    botMode: result?.botMode || '',
  }
}

function getVoiceAssetsModule(): VoiceAssetsModule {
  return require(path.join(AI_LIB, 'media', 'voice', 'voice-assets')) as VoiceAssetsModule
}

function getPersonaModule(): PersonaModule {
  return require(path.join(AI_LIB, 'persona', 'persona')) as PersonaModule
}

function getPersonaVoiceConfigs(): PersonaVoiceConfigEntry[] {
  const personaModule = getPersonaModule()
  const personas = personaModule.getAvailablePersonals({ userFacing: true })
  return personas.map(p => {
    const name = p.name as string
    const content = personaModule.loadPersonalSkill(name)
    const meta = content ? personaModule.parsePersonaFrontmatter(content) : {}
    return {
      name,
      voice: (meta.voice_id || meta.voice || '') as string,
      voiceAssetId: (meta.voice_asset_id || '') as string,
      style: (meta.voice_style || '') as string,
      hasSample: false,
    }
  })
}

function findPersonaSkillFile(personaName: unknown, personaModule: PersonaModule = getPersonaModule()): PersonaSkillFile | null {
  const searchDirs = ['personas', 'core', 'modes'].map((d: string) => path.join(DATA_DIR, 'ai-skills', d))
  for (const skillsDir of searchDirs) {
    if (!fs.existsSync(skillsDir)) continue
    const entries = fs.readdirSync(skillsDir) as string[]
    for (const entry of entries) {
      if (!/^SKILL(\.[^.]+)?\.md$/i.test(entry)) continue
      const fp = path.join(skillsDir, entry)
      const fc = fs.readFileSync(fp, 'utf8')
      const meta = personaModule.parsePersonaFrontmatter(fc)
      if (meta.name === personaName) return { file: fp, content: fc }
    }
  }
  return null
}

function cleanFrontmatterValue(value: unknown, fallback = '', maxLength = 240): string {
  return String(value || fallback).replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength)
}

function writePersonaVoiceConfig(personaName: unknown, voiceId: unknown, voiceStyle: unknown, voiceAssetId: unknown = ''): string | null {
  const personaModule = getPersonaModule()
  const target = findPersonaSkillFile(personaName, personaModule)
  if (!target) return null
  const nextVoice = cleanFrontmatterValue(voiceId, '冰糖')
  const nextStyle = cleanFrontmatterValue(voiceStyle)
  const nextAssetId = cleanFrontmatterValue(voiceAssetId)
  const lines = [`voice_id: ${nextVoice}`]
  if (nextVoice === '__cloned__' && nextAssetId) lines.push(`voice_asset_id: ${nextAssetId}`)
  if (nextStyle) lines.push(`voice_style: ${nextStyle}`)
  const insert = lines.join('\n') + '\n'
  let updated = target.content
  if (/^---\n[\s\S]*?\n---/.test(updated)) {
    updated = updated.replace(/^(---\n[\s\S]*?)(voice_id:[^\n]*\n)/m, '$1')
    updated = updated.replace(/^(---\n[\s\S]*?)(voice_asset_id:[^\n]*\n)/m, '$1')
    updated = updated.replace(/^(---\n[\s\S]*?)(voice_style:[^\n]*\n)/m, '$1')
    updated = updated.replace(/^(---\n[\s\S]*?)(voice:[^\n]*\n)/m, '$1')
    updated = updated.replace(/^---\n/, `---\n${insert}`)
  } else {
    updated = `---\n${insert}---\n${target.content}`
  }
  fs.writeFileSync(target.file, updated, 'utf8')
  return target.file
}

function handleGetTtsVoices(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    const tts = getTtsModule()
    const voiceAssets = getVoiceAssetsModule()
    const voiceConfigs = getPersonaVoiceConfigs()
    const clonedVoices = voiceAssets.listVoiceAssets(voiceConfigs)
    const liveAssets = clonedVoices.filter(asset => !asset.missing)
    for (const vc of voiceConfigs) {
      const hasBoundSample = liveAssets.some(asset =>
        (vc.voiceAssetId && asset.id === vc.voiceAssetId) ||
        asset.personaName === vc.name ||
        asset.id === voiceAssets.sanitizeVoiceAssetId(vc.name)
      )
      // Keep the clone mode visible for personas that are already configured to use it.
      vc.hasSample = hasBoundSample || vc.voice === '__cloned__'
    }
    return json(res, {
      ok: true,
      builtin: tts.BUILTIN_VOICES,
      personas: voiceConfigs,
      clonedVoices: clonedVoices.map(asset => {
        const referencedBy = voiceAssets.listVoiceAssetReferences(asset, voiceConfigs)
        return { ...asset, referencedBy, isCurrent: referencedBy.length > 0, boundPersona: asset.personaName }
      }),
    })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
}

function handlePostTtsClone(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, async (body) => {
    try {
      const data = JSON.parse(body || '{}') as TtsCloneBody
      const { personaName, audioBase64, mimeType, displayName, description, sampleText } = data
      if (!personaName || !audioBase64) return json(res, { ok: false, message: '缺少 personaName 或 audioBase64' }, 400)
      const buf = Buffer.from(audioBase64 as string, 'base64')
      if (buf.length > MAX_TTS_CLONE_AUDIO_BYTES) return json(res, { ok: false, message: `音频文件超过 ${Math.floor(MAX_TTS_CLONE_AUDIO_BYTES / 1024 / 1024)}MB 限制` }, 400)
      if (buf.length < 1024) return json(res, { ok: false, message: '音频文件过小，可能无效' }, 400)
      const voiceAssets = getVoiceAssetsModule()
      const ext = voiceAssets.getAudioExtFromMime(mimeType)
      const voicesDir = path.join(DATA_DIR, 'ai-voices')
      fs.mkdirSync(voicesDir, { recursive: true })
      const assetId = voiceAssets.createVoiceAssetId(personaName)
      const filename = voiceAssets.buildVoiceAssetFilename(assetId, mimeType || ext)
      const filePath = path.join(voicesDir, filename)
      fs.writeFileSync(filePath, buf)
      const tts = getTtsModule()
      const ttsResource = getTtsResourceModule()
      const dataUri = `data:${mimeType || 'audio/mpeg'};base64,${audioBase64}`
      const cleanSampleText = String(sampleText || '').trim().slice(0, 120) || voiceAssets.DEFAULT_SAMPLE_TEXT
      const diagnostics: VoiceDiagnostics = {}
      const testResult = await ttsResource.runVoiceTtsWithResourceGate({
        source: 'dashboard-tts-clone',
        owner: 'dashboard-tts',
        channelKey: 'dashboard',
        userId: 'dashboard-admin',
        context: 'dashboard-tts-clone',
        waitTimeoutMs: 3000,
        logger: getTtsLogger(),
        run: () => tts.synthesizeSpeech(cleanSampleText, { voice: dataUri, style: '正常语气', diagnostics, logger: getTtsLogger(), context: 'dashboard:tts-clone' }),
      })
      if (!testResult.ok) {
        try { fs.unlinkSync(filePath) } catch { /* non-critical: failed clone cleanup */ }
        return json(res, buildTtsResourceBusyPayload(testResult), 503)
      }
      const testBuf = testResult.value
      if (!testBuf) {
        try { fs.unlinkSync(filePath) } catch { /* non-critical: failed clone cleanup */ }
        return json(res, { ok: false, message: 'MiMo voiceclone 验证失败，请检查音频格式或 API key', reason: diagnostics.lastError?.code || 'unknown' }, 400)
      }
      const asset = voiceAssets.upsertVoiceAsset({
        id: assetId,
        personaName,
        filename,
        displayName: displayName || `${personaName} 克隆音色`,
        description,
        sampleText: cleanSampleText,
        mimeType: mimeType || voiceAssets.getAudioMimeFromFilename(filename),
      })
      try {
        writePersonaVoiceConfig(personaName, '__cloned__', data.voiceStyle || '', asset.id)
      } catch { /* non-critical: voice config best effort */ }
      return json(res, { ok: true, message: '音色克隆成功', file: filename, asset })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
  })
}

function handlePostTtsPreview(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, async (body) => {
    try {
      const data = JSON.parse(body || '{}') as TtsPreviewBody
      const { text, voice, style, personaName, voiceAssetId } = data
      if (!text) return json(res, { ok: false, message: '缺少 text' }, 400)
      const tts = getTtsModule()
      const hasExplicitVoice = !!voice
      let resolvedVoice: unknown = voice || '冰糖'
      let resolvedStyle: unknown = style || ''
      if (resolvedVoice === '__cloned__') {
        let pName: unknown = personaName || data.persona || ''
        if (voiceAssetId) {
          const voiceAssets = getVoiceAssetsModule()
          const sample = voiceAssets.resolveVoiceSampleFile(pName, voiceAssetId)
          if (!sample) return json(res, { ok: false, message: '未找到克隆音色样本' }, 404)
          resolvedVoice = `data:${sample.mimeType || 'audio/mpeg'};base64,${fs.readFileSync(sample.filePath).toString('base64')}`
        } else if (!pName && resolvedVoice === '__cloned__') {
          try {
            const personaModule = getPersonaModule()
            const personas = personaModule.getAvailablePersonals({ userFacing: true })
            for (const p of personas) {
              const candidateName = String(p.name || '')
              const c = personaModule.loadPersonalSkill(candidateName)
              if (c) {
                const m = personaModule.parsePersonaFrontmatter(c)
                if (m.voice_id === '__cloned__') { pName = candidateName; break }
              }
            }
          } catch { /* non-critical: persona scan fallback */ }
        }
        if (resolvedVoice !== '__cloned__') {
          if (!resolvedStyle && pName) resolvedStyle = tts.resolvePersonaVoice(pName).style
        } else if (pName) {
          const resolved = tts.resolvePersonaVoice(pName)
          resolvedVoice = resolved.voice
          resolvedStyle = style || resolved.style
        } else if (resolvedVoice === '__cloned__') {
          return json(res, { ok: false, message: '没有配置克隆音色的人格' }, 400)
        }
      } else if (!hasExplicitVoice && personaName) {
        const resolved = tts.resolvePersonaVoice(personaName)
        resolvedVoice = resolved.voice
        resolvedStyle = style || resolved.style
      }
      if (!resolvedStyle && personaName) resolvedStyle = tts.resolvePersonaVoice(personaName).style
      const diagnostics: VoiceDiagnostics = {}
      const ttsResource = getTtsResourceModule()
      const ttsResult = await ttsResource.runVoiceTtsWithResourceGate({
        source: 'dashboard-tts-preview',
        owner: 'dashboard-tts',
        channelKey: 'dashboard',
        userId: 'dashboard-admin',
        context: 'dashboard-tts-preview',
        waitTimeoutMs: 3000,
        logger: getTtsLogger(),
        run: () => tts.synthesizeSpeech(String(text).slice(0, 200), { voice: resolvedVoice as string, style: resolvedStyle, diagnostics, logger: getTtsLogger(), context: 'dashboard:tts-preview' }),
      })
      if (!ttsResult.ok) return json(res, buildTtsResourceBusyPayload(ttsResult), 503)
      const buf = ttsResult.value
      if (!buf) return json(res, { ok: false, message: '语音合成失败，请检查 API key 或网络', reason: diagnostics.lastError?.code || 'unknown' }, 500)
      const mimeType = tts.detectAudioMime(buf) || buf.mimeType || 'audio/wav'
      return json(res, { ok: true, audio: buf.toString('base64'), format: mimeType.split('/')[1] || 'wav', mimeType })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
  })
}

function handlePostTtsCloneRename(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = JSON.parse(body || '{}') as TtsCloneRenameBody
      const assetId = data.id || data.oldName || data.name
      const displayName = data.displayName || data.newName
      if (!assetId || !displayName) return json(res, { ok: false, message: '缺少音色 ID 或显示名' }, 400)
      const voiceAssets = getVoiceAssetsModule()
      const asset = voiceAssets.updateVoiceAssetMetadata(assetId, {
        displayName,
        description: data.description,
        sampleText: data.sampleText,
      }, getPersonaVoiceConfigs())
      if (!asset) return json(res, { ok: false, message: '未找到音色资产：' + assetId }, 404)
      return json(res, { ok: true, message: '音色信息已更新', asset })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
  })
}

function handlePostTtsCloneDelete(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = JSON.parse(body || '{}') as TtsCloneDeleteBody
      const assetId = data.id || data.name
      if (!assetId) return json(res, { ok: false, message: '缺少音色 ID' }, 400)
      const voiceAssets = getVoiceAssetsModule()
      const voiceConfigs = getPersonaVoiceConfigs()
      const asset = voiceAssets.findVoiceAsset(assetId, voiceConfigs)
      if (!asset) return json(res, { ok: false, message: '未找到音色资产：' + assetId }, 404)
      const referencedNames = voiceAssets.listVoiceAssetReferences(asset, voiceConfigs)
      const usingPersonas = voiceConfigs.filter(vc => referencedNames.includes(vc.name))
      if (usingPersonas.length && !data.force) {
        return json(res, {
          ok: false,
          code: 'VOICE_ASSET_IN_USE',
          message: '该音色正在被人格使用',
          personas: referencedNames,
        }, 409)
      }
      const result = voiceAssets.deleteVoiceAsset(asset.id, voiceConfigs)
      if (!result) return json(res, { ok: false, message: '删除失败' }, 500)
      for (const vc of usingPersonas) {
        writePersonaVoiceConfig(vc.name, '冰糖', vc.style || '')
      }
      return json(res, { ok: true, message: '删除成功', deleted: result.deleted, asset: result.asset })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
  })
}

function handlePutPersonaVoice(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, async (body) => {
    try {
      const { personaName, voiceId, voiceStyle, voiceAssetId } = JSON.parse(body || '{}') as PersonaVoicePutBody
      if (!personaName) return json(res, { ok: false, message: '缺少 personaName' }, 400)
      const nextVoice = voiceId || '冰糖'
      if (nextVoice === '__cloned__') {
        const voiceAssets = getVoiceAssetsModule()
        const sample = voiceAssets.resolveVoiceSampleFile(personaName, voiceAssetId || '')
        if (!sample) return json(res, { ok: false, message: '该人格还没有可用的克隆音色样本' }, 400)
      }
      const targetFile = writePersonaVoiceConfig(personaName, nextVoice, voiceStyle || '', voiceAssetId || '')
      if (!targetFile) return json(res, { ok: false, message: '未找到人格文件' }, 404)
      return json(res, { ok: true, message: '音色配置已更新' })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
  })
}

function handleGetAgentStats(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    const stats = (require(path.join(AI_LIB, 'agent', 'stats')) as AgentStatsModule).getStats()
    return json(res, { ok: true, stats })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
}

function handleGetAgentQueue(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    const queue = (require(path.join(AI_LIB, 'agent', 'queue')) as AgentQueueModule).getAgentQueueStats()
    return json(res, { ok: true, queue })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
}

async function handleGetAgentFiles(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
  if (!requireAdmin(req, res)) return
  try {
    const query = url.searchParams.get('q') || ''
    const root = url.searchParams.get('root') || ''
    const limit = url.searchParams.get('limit') || 120
    const result = await listAgentWorkspaceFiles({ root, query, limit })
    return json(res, { ok: true, ...result })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
}

async function handleGetAgentFile(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
  if (!requireAdmin(req, res)) return
  try {
    const file = url.searchParams.get('path') || ''
    return json(res, { ok: true, file: await previewAgentWorkspaceFile(file) })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
}

async function handleGetAgentFileDownload(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
  if (!requireAdmin(req, res)) return
  try {
    const { abs } = await resolveAgentWorkspacePath(url.searchParams.get('path') || '')
    const stat = await fs.promises.stat(abs)
    if (!stat.isFile()) return json(res, { ok: false, message: '不是文件' }, 400)
    if (stat.size > MAX_DOWNLOAD_BYTES) return json(res, { ok: false, message: '文件过大，拒绝下载' }, 413)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(abs))}"`,
    })
    fs.createReadStream(abs).pipe(res)
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
}

function handlePostAgentFileUpload(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, async (body) => {
    try {
      const data = JSON.parse(body || '{}') as AgentFileUploadBody
      const content = String(data.content || '')
      if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) return json(res, { ok: false, message: '上传文件过大' }, 413)
      if (content.length > 2 * 1024 * 1024) return json(res, { ok: false, message: '上传文件过大' }, 413)
      const { abs } = await resolveAgentUploadTarget(data.root, data.name)
      await fs.promises.mkdir(path.dirname(abs), { recursive: true })
      await fs.promises.writeFile(abs, content, 'utf8')
      return json(res, { ok: true, file: { path: abs, name: path.basename(abs), size: Buffer.byteLength(content) } })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

async function handleGetAgentEnv(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return
  try {
    const runtime = await (require(path.join(AI_LIB, 'core', 'runtime-config')) as RuntimeConfigModule).loadConfig(true)
    return json(res, {
      ok: true,
      env: getAgentEnvStatus(),
      runtime: { provider: runtime.provider, model: runtime.model, baseURL: runtime.baseURL, apiKeyConfigured: !!runtime.apiKey, searchEnabled: !!runtime.searchEnabled },
    })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
}

function handleGetAgentShellGuard(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    const guard = require(path.join(AI_LIB, 'agent', 'tools', 'shell-guard')) as ShellGuardModule
    const categories = guard.listShellGuardRules()
    const ruleCount = categories.reduce((sum, item) => sum + item.count, 0)
    return json(res, { ok: true, enabled: true, ruleCount, categories })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
}

async function handleGetAgentPlans(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return
  try {
    const plans = await (require(path.join(AI_LIB, 'agent', 'plan', 'plan-store')) as AgentPlanStoreModule).listPlans(80)
    return json(res, { ok: true, plans })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
}

function handlePostAgentPlans(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, async (body) => {
    try {
      const data = JSON.parse(body || '{}') as AgentPlanCreateBody
      const goal = String(data.goal || data.title || '').trim()
      const rawTasks: unknown[] = Array.isArray(data.tasks) ? data.tasks : []
      if (!goal && rawTasks.length === 0) return json(res, { ok: false, message: '计划目标不能为空。' }, 400)
      const agentConfig = (require(path.join(AI_LIB, 'agent', 'config')) as AgentConfigModule).getAgentConfig()
      if (!agentConfig.planMode?.enabled) return json(res, { ok: false, message: '计划模式当前未开启。' }, 400)
      const tasks = rawTasks.length
        ? rawTasks.map(item => typeof item === 'string' ? { desc: item } : item)
        : goal.split(/(?:[;；]|\n|，然后|然后|再)/).map(item => item.trim()).filter(Boolean).slice(0, 8).map(desc => ({ desc }))
      const fallbackTasks = tasks.length >= 2 ? tasks : [
        { desc: `理解目标：${goal}` }, { desc: '收集必要信息并执行可用工具' }, { desc: '整理结果并汇报完成状态' },
      ]
      const createOptions: AgentCreatePlanOptions = {
        title: goal.slice(0, 80) || 'Dashboard Agent 计划', tasks: fallbackTasks, channel: 'dashboard',
        channelKey: 'dashboard', userId: String(data.userId || 'dashboard'), userName: String(data.userName || 'Dashboard'),
      }
      const plan = await (require(path.join(AI_LIB, 'agent', 'plan', 'plan-engine')) as AgentPlanEngineModule).createPlan(createOptions)
      return json(res, { ok: true, plan })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handleGetAgentPushLog(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    const pushLog = (require(path.join(AI_LIB, 'agent', 'push')) as AgentPushModule).listPushLog(80)
    return json(res, { ok: true, log: pushLog })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
}

async function handleGetAgentCrons(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return
  try {
    const cron = require(path.join(AI_LIB, 'agent', 'cron')) as AgentCronModule
    const data = await cron.loadCrons()
    const history = await cron.listCronHistory(50)
    return json(res, { ok: true, crons: data.crons, history })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
}

function handlePostAgentCrons(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, async (body) => {
    try {
      const data = JSON.parse(body || '{}') as AgentCronCreateBody
      const cron = await (require(path.join(AI_LIB, 'agent', 'cron')) as AgentCronModule).registerCron(data)
      return json(res, { ok: true, cron })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handleGetAgentSessions(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    const sessions = (require(path.join(AI_LIB, 'agent', 'sessions')) as AgentSessionModule).listAgentSessions()
    return json(res, { ok: true, sessions })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
}

function handlePostAgentChat(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, async (body) => {
    try {
      const data = JSON.parse(body || '{}') as AgentChatBody
      const message = String(data.message || '').trim()
      const enableThinking = !!data.enableThinking
      const agentMode = !!data.agentMode
      if (!message) return json(res, { ok: false, message: '消息不能为空' }, 400)
      const agentConfig = (require(path.join(AI_LIB, 'agent', 'config')) as AgentConfigModule).getAgentConfig()
      const workerSubmission = require(path.join(AI_LIB, 'agent', 'worker-submission')) as AgentWorkerSubmissionModule
      const agentPayload = require(path.join(AI_LIB, 'resource-workers', 'agent-payload')) as AgentWorkerPayloadModule
      const history = (require(path.join(AI_LIB, 'agent', 'messages')) as AgentMessagesModule).sanitizeAgentHistory(data.history)
      const searchRunOptions = (require(path.join(AI_LIB, 'agent', 'router')) as AgentRouterModule).buildExplicitSearchRunOptions(message)
      const agentRunInput = {
        userMessage: message, userName: String(data.userName || 'Dashboard'), userId: String(data.userId || 'dashboard'),
        channelKey: 'dashboard', channel: 'dashboard', history, enableThinking, agentMode, ...searchRunOptions,
      }
      const submission = workerSubmission.submitAgentWorkerTask({
        channel: 'dashboard',
        channelKey: 'dashboard',
        userId: String(data.userId || 'dashboard'),
        timeoutMs: agentConfig.queue?.timeoutMs,
        maxActivePerUser: agentConfig.queue?.maxPendingPerUser,
        source: 'dashboard-standalone',
        payload: { entry: 'dashboard-agent-chat', agentWorker: agentPayload.createAgentRunWorkerPayload('dashboard-agent-chat', agentRunInput) },
      })
      return json(res, {
        ok: submission.accepted,
        async: true,
        taskId: submission.taskId || '',
        status: submission.accepted ? 'accepted' : 'blocked',
        message: submission.message,
      }, submission.status || 202)
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
  })
}

function handlePostAgentConfirm(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, async (body) => {
    try {
      const pending = require(path.join(AI_LIB, 'agent', 'pending')) as AgentPendingModule
      const data = JSON.parse(body || '{}') as AgentConfirmBody
      const expectedId = String(data.pendingId || '')
      const directFindPendingById = pending.findPendingToolById || pending.getPendingToolById
      const p = expectedId
        ? directFindPendingById
          ? directFindPendingById(expectedId)
          : pending.listPendingTools().find(candidate => candidate.id === expectedId) || null
        : pending.getPendingTool('dashboard', 'dashboard')
      if (!p) return json(res, { ok: false, message: '没有待确认工具' }, 404)
      const workerSubmission = require(path.join(AI_LIB, 'agent', 'worker-submission')) as AgentWorkerSubmissionModule
      const agentPayload = require(path.join(AI_LIB, 'resource-workers', 'agent-payload')) as AgentWorkerPayloadModule
      const agentConfig = (require(path.join(AI_LIB, 'agent', 'config')) as AgentConfigModule).getAgentConfig()
      const resumeInput = { channelKey: p.channelKey, userId: p.userId, channel: p.channel || 'dashboard', expectedId }
      const pendingSnapshot = toDashboardPendingSnapshot(p)
      const submission = workerSubmission.submitAgentWorkerTask({
        channel: p.channel || 'dashboard',
        channelKey: p.channelKey,
        userId: p.userId,
        timeoutMs: agentConfig.queue?.timeoutMs,
        maxActivePerUser: agentConfig.queue?.maxPendingPerUser,
        source: 'dashboard-standalone',
        payload: { entry: 'dashboard-agent-confirm', pendingId: expectedId, agentWorker: agentPayload.createAgentResumeWorkerPayload('dashboard-agent-confirm', resumeInput, pendingSnapshot) },
      })
      return json(res, {
        ok: submission.accepted,
        async: true,
        toolName: p.toolName,
        taskId: submission.taskId || '',
        status: submission.accepted ? 'accepted' : 'blocked',
        message: submission.message,
      }, submission.status || 202)
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
  })
}

function handlePostAgentReject(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, async (body) => {
    try {
      const pending = require(path.join(AI_LIB, 'agent', 'pending')) as AgentPendingModule
      const data = JSON.parse(body || '{}') as AgentRejectBody
      const pendingId = String(data.pendingId || '')
      if (!pendingId) return json(res, { ok: false, message: 'pendingId 不能为空' }, 400)
      const ok = pending.clearPendingToolById(pendingId)
      if (!ok) return json(res, { ok: false, message: '没有匹配的待确认工具' }, 404)
      return json(res, { ok: true, message: '已拒绝工具请求' })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
  })
}

// --- Route Map ---

const routes = {
  'GET /dashboard/api/agent/config': handleGetAgentConfig,
  'PUT /dashboard/api/agent/config': handlePutAgentConfig,
  'GET /dashboard/api/agent/personas': handleGetAgentPersonas,
  'PUT /dashboard/api/agent/persona': handlePutAgentPersona,
  'GET /dashboard/api/agent/tts/voices': handleGetTtsVoices,
  'POST /dashboard/api/agent/tts/clone': handlePostTtsClone,
  'POST /dashboard/api/agent/tts/preview': handlePostTtsPreview,
  'POST /dashboard/api/agent/tts/clone/rename': handlePostTtsCloneRename,
  'POST /dashboard/api/agent/tts/clone/delete': handlePostTtsCloneDelete,
  'PUT /dashboard/api/agent/persona/voice': handlePutPersonaVoice,
  'GET /dashboard/api/agent/stats': handleGetAgentStats,
  'GET /dashboard/api/agent/queue': handleGetAgentQueue,
  'GET /dashboard/api/agent/files': handleGetAgentFiles,
  'GET /dashboard/api/agent/file': handleGetAgentFile,
  'GET /dashboard/api/agent/file/download': handleGetAgentFileDownload,
  'POST /dashboard/api/agent/file/upload': handlePostAgentFileUpload,
  'GET /dashboard/api/agent/env': handleGetAgentEnv,
  'GET /dashboard/api/agent/shell-guard': handleGetAgentShellGuard,
  'GET /dashboard/api/agent/plans': handleGetAgentPlans,
  'POST /dashboard/api/agent/plans': handlePostAgentPlans,
  'GET /dashboard/api/agent/push-log': handleGetAgentPushLog,
  'GET /dashboard/api/agent/crons': handleGetAgentCrons,
  'POST /dashboard/api/agent/crons': handlePostAgentCrons,
  'GET /dashboard/api/agent/sessions': handleGetAgentSessions,
  'POST /dashboard/api/agent/chat': handlePostAgentChat,
  'POST /dashboard/api/agent/confirm': handlePostAgentConfirm,
  'POST /dashboard/api/agent/reject': handlePostAgentReject,
} satisfies Record<string, AgentRouteHandler>

const regexRoutes: AgentRegexRoute[] = [
  { pattern: /^\/dashboard\/api\/agent\/plans\/([^/]+)$/, method: 'GET', handler: async (req, res, match) => {
    if (!requireAdmin(req, res)) return
    try {
      const plan = await (require(path.join(AI_LIB, 'agent', 'plan', 'plan-store')) as AgentPlanStoreModule).loadPlan(decodeURIComponent(match[1]))
      if (!plan) return json(res, { ok: false, message: '计划不存在' }, 404)
      return json(res, { ok: true, plan })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
  }},
  { pattern: /^\/dashboard\/api\/agent\/tasks\/([^/]+)$/, method: 'GET', handler: (req, res, match) => {
    if (!requireAdmin(req, res)) return
    try {
      const taskId = decodeURIComponent(match[1])
      const taskStore = require(path.join(AI_LIB, 'resource-workers', 'task-store')) as AgentTaskStoreModule
      const task = taskStore.getResourceTaskById(taskId)
      if (!task) return json(res, { ok: false, message: '任务不存在' }, 404)
      const result = ['done', 'failed'].includes(String(task.status || '')) ? readAgentTaskResult(taskId) : {}
      return json(res, { ok: true, task: sanitizeAgentTaskForDashboard(task, result) })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
  }},
  { pattern: /^\/dashboard\/api\/agent\/plans\/([^/]+)\/resume$/, method: 'POST', handler: (req, res, match) => {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, async (body) => {
      try {
        const data = JSON.parse(body || '{}') as AgentPlanResumeBody
        const result = await (require(path.join(AI_LIB, 'agent', 'plan', 'plan-runner')) as AgentPlanRunnerModule).resumePlan({
          planId: decodeURIComponent(match[1]), channelKey: 'dashboard',
          userId: String(data.userId || 'dashboard'), userName: String(data.userName || 'Dashboard'), channel: 'dashboard',
        })
        return json(res, { ok: true, ...toObjectSpreadSource(result) })
      } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
    })
  }},
  { pattern: /^\/dashboard\/api\/agent\/plans\/([^/]+)\/abandon$/, method: 'POST', handler: (req, res, match) => {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, async (body) => {
      try {
        const data = JSON.parse(body || '{}') as AgentPlanAbandonBody
        const plan = await (require(path.join(AI_LIB, 'agent', 'plan', 'plan-engine')) as AgentPlanEngineModule).abandonPlan({
          planId: decodeURIComponent(match[1]), reason: data.reason || 'Agent Console 放弃计划',
        })
        return json(res, { ok: true, plan })
      } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
    })
  }},
  { pattern: /^\/dashboard\/api\/agent\/crons\/([^/]+)\/run$/, method: 'POST', handler: async (req, res, match) => {
    if (!requireAdmin(req, res)) return
    try {
      const result = await (require(path.join(AI_LIB, 'agent', 'cron')) as AgentCronModule).runCronNow(decodeURIComponent(match[1]))
      return json(res, { ok: true, result })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  }},
  { pattern: /^\/dashboard\/api\/agent\/crons\/([^/]+)$/, method: 'DELETE', handler: async (req, res, match) => {
    if (!requireAdmin(req, res)) return
    try {
      const removed = await (require(path.join(AI_LIB, 'agent', 'cron')) as AgentCronModule).unregisterCron(decodeURIComponent(match[1]))
      return json(res, { ok: true, removed })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  }},
  { pattern: /^\/dashboard\/api\/agent\/sessions\/(.+)$/, method: 'GET', handler: (req, res, match) => {
    if (!requireAdmin(req, res)) return
    try {
      const id = decodeURIComponent(match[1])
      const session = (require(path.join(AI_LIB, 'agent', 'sessions')) as AgentSessionModule).getAgentSession(id)
      if (!session) return json(res, { ok: false, message: '会话不存在' }, 404)
      return json(res, { ok: true, session })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
  }},
]

export = { routes, regexRoutes, getAgentEnvStatus }
