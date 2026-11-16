'use strict'

/** 参与开关管理：管理员鉴权、首次启用默认值和多文件原子事务。 */
import type { IncomingMessage, ServerResponse } from 'http'
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { json, collectBody, getErrorMessage } = require('../utils') as typeof import('../utils')
const { requireAdmin } = require('../auth') as typeof import('../auth')
const { DATA_DIR } = require('../paths') as typeof import('../paths')
const { executeConfigTransaction } = require('../config-transaction') as typeof import('../config-transaction')
const { readGroupNames } = require('../group-directory') as typeof import('../group-directory')
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime') as typeof import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const policy = loadManagementModule('core.participationPolicy')

interface UpdateBody { kind: 'private' | 'group' | 'group-abusive'; enabled: boolean; groupId?: string }
interface WriteTarget { name: string; filePath: string; content: Buffer }

const GROUP_NAMES_FILE = 'dashboard-group-names.json'
const MAX_GROUP_NAME_LENGTH = 128
let groupNameImportQueue: Promise<void> = Promise.resolve()

// --- 群名导入与手动备注 ---

// 只读取本地保存的群名；空字符串也表示已经导入，刷新时不再查询 QQ。
function readSavedGroupNames(): Record<string, string> {
  const value = readFeatureFile(GROUP_NAMES_FILE, {})
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('已保存群名格式无效')
  for (const [id, name] of Object.entries(value)) {
    if (!policy.GROUP_ID_PATTERN.test(id) || typeof name !== 'string' || name.length > MAX_GROUP_NAME_LENGTH) throw new Error('已保存群号或群名无效')
  }
  return value as Record<string, string>
}

// 在配置事务内保存群名并回读校验，失败时保留原有备注。
function saveGroupNames(groups: Record<string, string>): void {
  executeConfigTransaction({
    dataDir: DATA_DIR,
    targets: [target(GROUP_NAMES_FILE, groups)],
    refresh: () => { readSavedGroupNames() },
    verify: () => {
      if (JSON.stringify(readSavedGroupNames()) !== JSON.stringify(groups)) throw new Error('群名写入校验失败')
    },
  })
}

// 串行导入缺失群名，异步读取后重新合并，避免覆盖同时提交的手动名称。
function importGroupNames(ids: string[]): Promise<{ groups: Record<string, string>; message?: string }> {
  const operation = groupNameImportQueue.then(async () => {
    const saved = readSavedGroupNames()
    const missing = ids.filter(id => !Object.prototype.hasOwnProperty.call(saved, id))
    if (!missing.length) return { groups: saved }
    let directory: Record<string, string> = {}
    let message: string | undefined
    try { directory = await readGroupNames() }
    catch { message = '群名读取失败，已保留群号，请手动填写名称。' }
    const groups = readSavedGroupNames()
    for (const id of missing) {
      if (!Object.prototype.hasOwnProperty.call(groups, id)) groups[id] = (directory[id] || '').slice(0, MAX_GROUP_NAME_LENGTH)
    }
    saveGroupNames(groups)
    return { groups, message }
  })
  groupNameImportQueue = operation.then(() => {}, () => {})
  return operation
}

// --- 功能默认值与原子保存 ---

// 读取已有功能文件，缺失文件沿用该功能明确的默认数据。
function readFeatureFile(name: string, fallback: unknown): unknown {
  const filePath = path.join(DATA_DIR, name)
  if (!fs.existsSync(filePath)) return fallback
  if (fs.statSync(filePath).size > 256 * 1024) throw new Error(`${name} 文件过大`)
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

// 校验黑白名单已经使用的字符串或数字 ID 数组。
function readIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' && typeof id !== 'number')) throw new Error('已有黑白名单格式无效')
  return value.map(String)
}

// 将一个 JSON 配置加入现有跨文件事务，数据仍留在共享 data 目录。
function target(name: string, value: unknown): WriteTarget {
  return { name, filePath: path.join(DATA_DIR, name), content: Buffer.from(JSON.stringify(value, null, 2) + '\n') }
}

// 首次启用群时关闭主动回复、开启复读，并解除该群的视频和集合禁用。
function initialGroupTargets(groupId: string): WriteTarget[] {
  const random = readIds(readFeatureFile('ai-random-whitelist.json', []))
  const repeat = readFeatureFile('ai-repeat-enabled.json', {})
  if (!repeat || typeof repeat !== 'object' || Array.isArray(repeat)) throw new Error('已有复读配置格式无效')
  const video = readFeatureFile('video-blacklist.json', { groups: [], users: [] })
  const videoObject = Array.isArray(video) ? { groups: video, users: [] } : video as { groups?: unknown; users?: unknown }
  if (!videoObject || typeof videoObject !== 'object') throw new Error('已有视频黑名单格式无效')
  const nickname = readFeatureFile('group-name-at-disabled-groups.json', { groups: [] })
  const nicknameGroups = Array.isArray(nickname) ? nickname : (nickname as { groups?: unknown } | null)?.groups
  return [
    target('ai-random-whitelist.json', random.filter(id => id !== groupId)),
    target('ai-repeat-enabled.json', { ...repeat, [groupId]: true }),
    target('video-blacklist.json', { groups: readIds(videoObject.groups || []).filter(id => id !== groupId), users: readIds(videoObject.users || []) }),
    target('group-name-at-disabled-groups.json', { groups: readIds(nicknameGroups || []).filter(id => id !== groupId) }),
  ]
}

// 保存总开关；首次启用默认配置和总开关一起提交，失败时一起恢复。
function saveParticipationUpdate(body: UpdateBody): ReturnType<typeof policy.readParticipationPolicy> {
  const next = policy.readParticipationPolicy()
  const targets: WriteTarget[] = []
  if (body.kind === 'private') next.privateEnabled = body.enabled
  else if (body.kind === 'group-abusive') next.abusiveGroups[body.groupId!] = body.enabled
  else {
    const id = body.groupId!
    const configured = Object.prototype.hasOwnProperty.call(next.groups, id)
    if (!configured && body.enabled) targets.push(...initialGroupTargets(id))
    // 未曾启用的群本来就是关闭状态，不将其误记为已应用默认配置。
    if (configured || body.enabled) next.groups[id] = body.enabled
  }
  targets.push({ name: 'bot-participation.json', filePath: policy.PARTICIPATION_POLICY_FILE, content: Buffer.from(JSON.stringify(next, null, 2) + '\n') })
  executeConfigTransaction({
    dataDir: DATA_DIR,
    targets,
    refresh: () => { policy.readParticipationPolicy() },
    verify: () => {
      if (JSON.stringify(policy.readParticipationPolicy()) !== JSON.stringify(next)) throw new Error('参与开关写入校验失败')
    },
  })
  return next
}

// --- 管理员 HTTP 路由 ---

// 返回当前配置，未配置的群和私聊均显示为关闭。
function handleGetParticipation(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try { json(res, { ok: true, policy: policy.readParticipationPolicy() }) }
  catch (error) { json(res, { ok: false, message: getErrorMessage(error) }, 500) }
}

// 读取持久群名，不查询 QQ，也不会覆盖管理员修改的名称。
function handleGetGroupNames(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try { json(res, { ok: true, groups: readSavedGroupNames() }) }
  catch (error) { json(res, { ok: false, message: getErrorMessage(error) }, 500) }
}

// 仅为已加入总开关列表且尚未保存名称的群读取一次 QQ 群名。
function handleImportGroupNames(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, async text => {
    let body: { groupIds?: unknown } | null
    try { body = JSON.parse(text) } catch { return json(res, { ok: false, message: '请求必须是有效 JSON' }, 400) }
    try {
      const current = policy.readParticipationPolicy()
      if (!body || !Array.isArray(body.groupIds) || body.groupIds.length > 1000 || body.groupIds.some(id => typeof id !== 'string' || !policy.GROUP_ID_PATTERN.test(id) || !(id in current.groups || id in current.abusiveGroups))) {
        return json(res, { ok: false, message: '请提供已加入列表的有效群号' }, 400)
      }
      json(res, { ok: true, ...await importGroupNames([...new Set(body.groupIds as string[])]) })
    } catch (error) { json(res, { ok: false, message: getErrorMessage(error) }, 500) }
  })
}

// 编辑控制台名称，只更新本地备注，不调用 QQ 改名接口。
function handlePutGroupName(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, text => {
    let body: { groupId?: unknown; name?: unknown } | null
    try { body = JSON.parse(text) } catch { return json(res, { ok: false, message: '请求必须是有效 JSON' }, 400) }
    if (!body || typeof body.groupId !== 'string' || !policy.GROUP_ID_PATTERN.test(body.groupId) || typeof body.name !== 'string' || body.name.trim().length > MAX_GROUP_NAME_LENGTH) {
      return json(res, { ok: false, message: '请提供有效群号和不超过 128 字的群名' }, 400)
    }
    try {
      const current = policy.readParticipationPolicy()
      if (!(body.groupId in current.groups || body.groupId in current.abusiveGroups)) return json(res, { ok: false, message: '请先将群加入总开关列表' }, 400)
      const groups = { ...readSavedGroupNames(), [body.groupId]: body.name.trim() }
      saveGroupNames(groups)
      json(res, { ok: true, groups, message: '群名已保存' })
    } catch (error) { json(res, { ok: false, message: getErrorMessage(error) }, 500) }
  })
}

// 只允许管理员提交明确的布尔开关和有效数字群号。
function handlePutParticipation(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, text => {
    let value: unknown
    try { value = JSON.parse(text) } catch { return json(res, { ok: false, message: '请求必须是有效 JSON' }, 400) }
    const body = value as Partial<UpdateBody> | null
    if (!body || (body.kind !== 'private' && body.kind !== 'group' && body.kind !== 'group-abusive') || typeof body.enabled !== 'boolean' || (body.kind !== 'private' && (typeof body.groupId !== 'string' || !policy.GROUP_ID_PATTERN.test(body.groupId)))) {
      return json(res, { ok: false, message: '请提供正确的开关类型、布尔状态和群号' }, 400)
    }
    try {
      const saved = saveParticipationUpdate(body as UpdateBody)
      const label = body.kind === 'group-abusive' ? '嘴臭开关' : '总开关'
      json(res, { ok: true, policy: saved, message: body.kind === 'private' ? `全局私聊已${body.enabled ? '开启' : '关闭'}` : `群 ${body.groupId} ${label}已${body.enabled ? '开启' : '关闭'}` })
    } catch (error) { json(res, { ok: false, message: getErrorMessage(error) }, 500) }
  })
}

export const routes = {
  'GET /dashboard/api/groups': handleGetGroupNames,
  'POST /dashboard/api/groups/import': handleImportGroupNames,
  'PUT /dashboard/api/groups': handlePutGroupName,
  'GET /dashboard/api/participation': handleGetParticipation,
  'PUT /dashboard/api/participation': handlePutParticipation,
}
