'use strict'

/** 参与开关管理：管理员鉴权、首次启用默认值和多文件原子事务。 */
import type { IncomingMessage, ServerResponse } from 'http'
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { json, collectBody, getErrorMessage } = require('../utils') as typeof import('../utils')
const { requireAdmin } = require('../auth') as typeof import('../auth')
const { DATA_DIR } = require('../paths') as typeof import('../paths')
const { executeConfigTransaction } = require('../config-transaction') as typeof import('../config-transaction')
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime') as typeof import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const policy = loadManagementModule('core.participationPolicy')

interface UpdateBody { kind: 'private' | 'group'; enabled: boolean; groupId?: string }
interface WriteTarget { name: string; filePath: string; content: Buffer }

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

// 只允许管理员提交明确的布尔开关和有效数字群号。
function handlePutParticipation(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, text => {
    let value: unknown
    try { value = JSON.parse(text) } catch { return json(res, { ok: false, message: '请求必须是有效 JSON' }, 400) }
    const body = value as Partial<UpdateBody> | null
    if (!body || (body.kind !== 'private' && body.kind !== 'group') || typeof body.enabled !== 'boolean' || (body.kind === 'group' && (typeof body.groupId !== 'string' || !policy.GROUP_ID_PATTERN.test(body.groupId)))) {
      return json(res, { ok: false, message: '请提供正确的开关类型、布尔状态和群号' }, 400)
    }
    try {
      const saved = saveParticipationUpdate(body as UpdateBody)
      json(res, { ok: true, policy: saved, message: body.kind === 'private' ? `全局私聊已${body.enabled ? '开启' : '关闭'}` : `群 ${body.groupId} 总开关已${body.enabled ? '开启' : '关闭'}` })
    } catch (error) { json(res, { ok: false, message: getErrorMessage(error) }, 500) }
  })
}

export const routes = {
  'GET /dashboard/api/participation': handleGetParticipation,
  'PUT /dashboard/api/participation': handlePutParticipation,
}
