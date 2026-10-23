/**
 * MODULE: 随机图片需求短期授权。
 * 职责: 让独立媒体进程核验已经获准的单图随机话题是否仍在原回复时效内。
 * 边界: 不做概率抽样、不下载图片、不调用模型；仅活动需求落盘，每频道一份。
 */
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { createHash, randomUUID } = require('crypto') as typeof import('crypto')
const { DATA_DIR } = require('../../core/constants') as typeof import('../../core/constants')
const { readJsonFile, writeJsonAtomic, isProcessAlive } = require('../../resource-common/files') as typeof import('../../resource-common/files')

interface RandomImageAuthorization { token: string; expiresAt: number }
interface StoredRandomImageAuthorization extends RandomImageAuthorization { channelKey: string; messageId: string; pid: number }
const AUTHORIZATION_ROOT = path.join(DATA_DIR, 'random-image-demands')
const activeAuthorizations = new Map<string, StoredRandomImageAuthorization>()
const MAX_ACTIVE_AUTHORIZATIONS = 200

// 频道只参与哈希命名，不能把外部编号作为路径。
function authorizationFile(channelKey: string): string {
  return path.join(AUTHORIZATION_ROOT, createHash('sha256').update(channelKey).digest('hex') + '.json')
}

// 只接受完整的内部授权参数，随机任务缺少授权时不能退化成普通历史识图。
function readRandomImageAuthorization(value: unknown): RandomImageAuthorization | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.token !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(record.token)) return null
  if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) return null
  return { token: record.token, expiresAt: record.expiresAt }
}

// 新消息只撤销本进程真正登记过的随机图片需求，普通入站不会新增文件写入。
function revokeRandomImageDemand(channelKey: string): void {
  const active = activeAuthorizations.get(channelKey)
  if (!active) return
  const file = authorizationFile(channelKey)
  if (readJsonFile<StoredRandomImageAuthorization>(file)?.token === active.token) fs.rmSync(file, { force: true })
  activeAuthorizations.delete(channelKey)
}

// 插件停止时撤销本轮全部授权，不能把随机队列工作留到下一次启动。
function clearRandomImageDemands(): void {
  for (const channelKey of activeAuthorizations.keys()) revokeRandomImageDemand(channelKey)
}

// 仅在获准工具登记单图随机需求时签发，期限不能超过既有六十秒窗口。
function createRandomImageDemand(channelKey: string, messageId: string, expiresAt: number): RandomImageAuthorization | null {
  const now = Date.now()
  if (!channelKey || !messageId || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 60000) return null
  const previous = activeAuthorizations.get(channelKey)
  if (previous?.messageId === messageId && previous.expiresAt === expiresAt && isRandomImageDemandValid(channelKey, messageId, previous)) return { token: previous.token, expiresAt }
  revokeRandomImageDemand(channelKey)
  for (const [key, active] of activeAuthorizations) if (active.expiresAt <= now) revokeRandomImageDemand(key)
  if (activeAuthorizations.size >= MAX_ACTIVE_AUTHORIZATIONS) revokeRandomImageDemand(activeAuthorizations.keys().next().value!)
  const authorization: StoredRandomImageAuthorization = { token: randomUUID(), expiresAt, channelKey, messageId, pid: process.pid }
  writeJsonAtomic(authorizationFile(channelKey), authorization)
  activeAuthorizations.set(channelKey, authorization)
  return { token: authorization.token, expiresAt }
}

// 后台在实际请求前读取主进程授权；身份、时效、所有者存活三者都必须有效。
function isRandomImageDemandValid(channelKey: string, messageId: string, value: unknown): boolean {
  const authorization = readRandomImageAuthorization(value)
  if (!authorization || authorization.expiresAt <= Date.now()) return false
  const stored = readJsonFile<StoredRandomImageAuthorization>(authorizationFile(channelKey), null, 4096)
  return !!stored && stored.token === authorization.token && stored.expiresAt === authorization.expiresAt
    && stored.channelKey === channelKey && stored.messageId === messageId && isProcessAlive(stored.pid)
}

// 复用现有图片维护周期清理过期或死进程授权，不产生常驻定时器。
function cleanupRandomImageDemands(): void {
  for (const [key, active] of activeAuthorizations) if (active.expiresAt <= Date.now()) revokeRandomImageDemand(key)
  if (!fs.existsSync(AUTHORIZATION_ROOT)) return
  for (const name of fs.readdirSync(AUTHORIZATION_ROOT)) {
    if (!name.endsWith('.json')) continue
    const file = path.join(AUTHORIZATION_ROOT, name)
    const stored = readJsonFile<StoredRandomImageAuthorization>(file, null, 4096)
    if (!stored || stored.expiresAt <= Date.now() || !isProcessAlive(stored.pid)) fs.rmSync(file, { force: true })
  }
}

export = { createRandomImageDemand, readRandomImageAuthorization, isRandomImageDemandValid, revokeRandomImageDemand, clearRandomImageDemands, cleanupRandomImageDemands }
