const { segment } = require('koishi')
const fs = require('fs/promises')
const path = require('path')

exports.name = 'group-name-at'

const PLUGIN_VERSION = '0.4.7'
function resolveRuntimeDataDir() {
  const configured = String(process.env.DONGXUELIAN_AI_DATA_DIR || '').trim()
  if (configured) return path.resolve(configured)
  const koishiDir = String(process.env.KOISHI_DIR || process.env.KOISHI_APP_DIR || '').trim()
  if (koishiDir) return path.resolve(koishiDir, 'data')
  return path.resolve(process.cwd(), 'data')
}

const DEFAULT_DATA_DIR = resolveRuntimeDataDir()
const LEGACY_DATA_FILE = process.env.GROUP_NAME_AT_DATA_FILE || path.join(DEFAULT_DATA_DIR, 'nickname-collections.json')
const SCOPE_DATA_DIR = path.resolve(process.env.GROUP_NAME_AT_DATA_DIR || path.join(DEFAULT_DATA_DIR, 'nickname-collections'))
const USE_LEGACY_STORE = !!String(process.env.GROUP_NAME_AT_DATA_FILE || '').trim()
const DATA_FILE = LEGACY_DATA_FILE
const DISABLED_GROUPS_FILE = process.env.GROUP_NAME_AT_DISABLED_GROUPS_FILE || path.join(DEFAULT_DATA_DIR, 'group-name-at-disabled-groups.json')
const ADMIN_IDS_FILE = process.env.GROUP_NAME_AT_ADMIN_IDS_FILE || path.join(DEFAULT_DATA_DIR, 'ai-admin-ids.json')
const CONFIRM_TIMEOUT = 60 * 1000
const MAX_DISABLED_GROUPS_BYTES = 128 * 1024
const MAX_ADMIN_IDS_BYTES = 128 * 1024
const MAX_PENDING_CONFIRMS = 500
const MAX_STORE_FILE_BYTES = 2 * 1024 * 1024
const STORE_VERSION = 1

const CMD = {
  alias: '昵称',
  deleteAlias: '删除昵称',
  viewAlias: '查看昵称',
  viewCollection: '查看集合',
  viewAllAliases: '查看全部昵称',
  viewAllCollections: '查看全部集合',
  collectionList: '集合列表',
  whoIs: '谁是',
  createCollection: '创建集合',
  addCollection: '集合添加',
  removeCollection: '集合删除',
  clearCollection: '清空集合',
  confirmClearCollection: '确认清空集合',
  deleteCollection: '删除集合',
  confirmDeleteCollection: '确认删除集合',
  renameCollection: '重命名集合',
  renameAlias: '重命名昵称',
  copyCollection: '复制集合',
  mergeCollection: '合并集合',
  intersectCollection: '集合交集',
  unionCollection: '集合并集',
  diffCollection: '集合差集',
  viewMember: '查看成员',
  nicknameBlacklistView: '群聊昵称黑名单查看',
  nicknameBlacklistAdd: '群聊昵称黑名单添加',
  nicknameBlacklistDelete: '群聊昵称黑名单删除',
}

const TEXT = {
  aliasEmpty: '名称不能为空。',
  mentionRequired: '请至少 @ 一个成员。',
  memberRequired: '请指定成员名或 @ 一个成员。',
  aliasNotFound: (alias) => `没有找到「${alias}」。`,
  aliasAdded: (alias) => `昵称“${alias}”成功绑定到用户！`,
  aliasExists: (alias) => `昵称“${alias}”已经绑定过该用户。`,
  aliasRemoveMissing: (alias) => `「${alias}」下没有绑定该成员。`,
  aliasRemovedLast: (alias) => `已删除昵称「${alias}」。`,
  aliasRemoved: (alias, count) => `已从「${alias}」中移除该成员，当前剩余 ${count} 人。`,
  aliasListTitle: '本群昵称：',
  aliasListEmpty: '本群还没有昵称。',
  collectionListTitle: '本群集合：',
  collectionListEmpty: '本群还没有集合。',
  collectionTitle: (alias) => `集合：${alias}`,
  aliasTitle: (alias) => `昵称：${alias}`,
  collectionCount: (count) => `人数：${count}`,
  collectionCreated: (alias, count) => `已创建集合「${alias}」，当前共 ${count} 人。`,
  collectionAdded: (alias, added, count) => `已向集合「${alias}」添加 ${added} 人，当前共 ${count} 人。`,
  collectionRemoved: (alias, removed, count) => `已从集合「${alias}」移除 ${removed} 人，当前剩余 ${count} 人。`,
  collectionDeleted: (alias) => `已删除集合「${alias}」。`,
  collectionCleared: (alias) => `已清空集合「${alias}」。`,
  confirmDelete: (alias) => `危险操作：再次发送「确认删除集合 ${alias}」即可删除整个集合，60 秒内有效。`,
  confirmClear: (alias) => `危险操作：再次发送「确认清空集合 ${alias}」即可清空成员，60 秒内有效。`,
  renameDone: (from, to) => `已将「${from}」重命名为「${to}」。`,
  targetExists: (to) => `「${to}」已存在，不能覆盖。`,
  copied: (from, to, count) => `已复制集合「${from}」为「${to}」，共 ${count} 人。`,
  merged: (target, source, added, count) => `已将集合「${source}」合并到「${target}」，新增 ${added} 人，当前共 ${count} 人。`,
  memberNoAlias: (label) => `${label} 暂时没有昵称，也不在任何集合里。`,
  memberTitle: (label) => `${label} 的昵称 / 集合：`,
  setTitle: (type, left, right) => `${type}：${left} / ${right}`,
  storeReadFailed: '昵称数据读取失败，请检查文件格式或权限。',
  storeSaveFailed: '昵称数据保存失败，请检查文件权限。',
  blacklistEmpty: '群聊昵称黑名单为空。',
  blacklistTitle: '群聊昵称黑名单：',
  blacklistAdded: (groupId) => `已添加群聊昵称黑名单：${groupId}`,
  blacklistDeleted: (groupId) => `已移出群聊昵称黑名单：${groupId}`,
  blacklistGroupRequired: '请指定群号。',
  blacklistInvalidGroup: '群号必须是数字。',
  blacklistPermissionDenied: '只有群主、群管理员或bot管理员才能操作。',
  blacklistCrossGroupDenied: '群管理员只能操作当前群。',
  blacklistSaveFailed: '群聊昵称黑名单保存失败，请检查文件权限。',
}

let legacyNicknameStore = { scopes: {} }
let legacyStoreLoaded = false
let legacyStoreLoadError = null
const scopeStoreCache = new Map()
const pendingConfirms = new Map()
let legacySaveChain = Promise.resolve()
const scopeSaveChains = new Map()
let disabledGroupsCache = { fingerprint: '', groups: new Set() }

class StoreAccessError extends Error {
  constructor(userMessage, cause) {
    super(cause && cause.message ? cause.message : String(cause || userMessage))
    this.name = 'StoreAccessError'
    this.code = 'GROUP_NAME_AT_STORE_ACCESS'
    this.userMessage = userMessage
    this.cause = cause
  }
}

function createStoreAccessError(userMessage, cause) {
  return new StoreAccessError(userMessage, cause)
}

function handleStoreAccessError(ctx, error) {
  if (error && error.code === 'GROUP_NAME_AT_STORE_ACCESS') {
    ctx.logger('group-name-at').warn(error.message)
    return error.userMessage
  }
  throw error
}

async function safeSendText(ctx, session, text) {
  const value = String(text || '').trim()
  if (!value) return false
  try {
    await session.send(value)
    return true
  } catch (error) {
    ctx.logger('group-name-at').warn(`send failed: ${error?.message || error}`)
    return false
  }
}

function getScopeId(session) {
  return String(session.guildId || session.channelId || 'global')
}

function getGroupBlacklistCandidates(session) {
  const ids = []
  if (session.guildId) ids.push(String(session.guildId))
  if (!session.isDirect && session.channelId) ids.push(String(session.channelId))
  return [...new Set(ids.filter(Boolean))]
}

function isBlacklistedGroup(session) {
  const disabled = loadDisabledGroups()
  return getGroupBlacklistCandidates(session).some(groupId => disabled.groups.has(groupId))
}

function getSenderUserId(session) {
  return String(session.userId || session.author?.id || session.event?.user?.id || '')
}

function getGroupRole(session) {
  return String(session.event?.sender?.role || session.event?.member?.role || '')
}

function isGroupAdmin(session) {
  const role = getGroupRole(session)
  return role === 'owner' || role === 'admin'
}

function getFileFingerprint(filePath) {
  try {
    const stat = require('fs').statSync(filePath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]
}

function readAdminUserIds() {
  try {
    const fsSync = require('fs')
    const stat = fsSync.statSync(ADMIN_IDS_FILE)
    if (!stat.isFile() || stat.size > MAX_ADMIN_IDS_BYTES) return new Set()
    const parsed = JSON.parse(fsSync.readFileSync(ADMIN_IDS_FILE, 'utf8'))
    const ids = Array.isArray(parsed) ? parsed : []
    return new Set(uniqueStrings(ids.map(value => String(value || '').trim())))
  } catch {
    const fallback = String(process.env.DONGXUELIAN_DEFAULT_ADMIN_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
    return new Set(uniqueStrings(fallback))
  }
}

function hasBotAdminPermission(session) {
  return readAdminUserIds().has(getSenderUserId(session))
}

function loadDisabledGroups(force = false) {
  const fingerprint = getFileFingerprint(DISABLED_GROUPS_FILE)
  if (!force && disabledGroupsCache.fingerprint === fingerprint) return disabledGroupsCache
  let groups = []
  if (fingerprint !== 'missing') {
    try {
      const fsSync = require('fs')
      const stat = fsSync.statSync(DISABLED_GROUPS_FILE)
      if (!stat.isFile() || stat.size > MAX_DISABLED_GROUPS_BYTES) throw new Error('disabled group file too large')
      const raw = JSON.parse(fsSync.readFileSync(DISABLED_GROUPS_FILE, 'utf8'))
      groups = Array.isArray(raw) ? raw : Array.isArray(raw.groups) ? raw.groups : []
    } catch {
      groups = []
    }
  }
  disabledGroupsCache = { fingerprint, groups: new Set(uniqueStrings(groups)) }
  return disabledGroupsCache
}

async function saveDisabledGroups(groups) {
  const list = uniqueStrings([...groups]).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  try {
    await fs.mkdir(path.dirname(DISABLED_GROUPS_FILE), { recursive: true })
    const tmp = `${DISABLED_GROUPS_FILE}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify({ groups: list }, null, 2), 'utf8')
    await fs.rename(tmp, DISABLED_GROUPS_FILE)
    disabledGroupsCache = {
      fingerprint: getFileFingerprint(DISABLED_GROUPS_FILE),
      groups: new Set(list),
    }
  } catch (error) {
    throw createStoreAccessError(TEXT.blacklistSaveFailed, error)
  }
}

function normalizeName(name = '') {
  return String(name).replace(/\s+/g, ' ').trim()
}

function splitWords(text = '') {
  return normalizeName(text).split(' ').filter(Boolean)
}

function afterCommand(input, command) {
  if (input === command) return ''
  if (input.startsWith(command + ' ')) return normalizeName(input.slice(command.length))
  return null
}

function afterNumericAdminCommand(input, command) {
  const value = afterCommand(input, command)
  if (value !== null) return value
  if (input.startsWith(command)) return normalizeName(input.slice(command.length))
  return null
}

function parseCommandPair(plain, command) {
  const value = afterCommand(plain, command)
  if (!value) return null
  const args = splitWords(value)
  return args.length >= 2 ? [args[0], args[1]] : null
}

function parseNicknameBlacklistCommand(content = '') {
  const plain = stripMentions(content)
  if (plain === CMD.nicknameBlacklistView) return { action: 'view' }

  for (const [command, action] of [
    [CMD.nicknameBlacklistAdd, 'add'],
    [CMD.nicknameBlacklistDelete, 'delete'],
  ]) {
    const value = afterNumericAdminCommand(plain, command)
    if (value === null) continue
    const groupId = splitWords(value)[0] || ''
    return { action, groupId }
  }

  return null
}

function canManageNicknameBlacklist(session, targetGroupId) {
  if (hasBotAdminPermission(session)) return { ok: true }
  if (!isGroupAdmin(session)) return { ok: false, message: TEXT.blacklistPermissionDenied }
  const currentGroups = getGroupBlacklistCandidates(session)
  if (!currentGroups.includes(String(targetGroupId))) {
    return { ok: false, message: TEXT.blacklistCrossGroupDenied }
  }
  return { ok: true }
}

async function handleNicknameBlacklistCommand(session, command) {
  const disabled = loadDisabledGroups()
  if (command.action === 'view') {
    const permission = hasBotAdminPermission(session) || isGroupAdmin(session)
    if (!permission) return TEXT.blacklistPermissionDenied
    const list = [...disabled.groups].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    return list.length ? [TEXT.blacklistTitle, ...list].join('\n') : TEXT.blacklistEmpty
  }

  const groupId = String(command.groupId || '').trim()
  if (!groupId) return TEXT.blacklistGroupRequired
  if (!/^\d+$/.test(groupId)) return TEXT.blacklistInvalidGroup

  const permission = canManageNicknameBlacklist(session, groupId)
  if (!permission.ok) return permission.message

  const groups = new Set(disabled.groups)
  if (command.action === 'add') groups.add(groupId)
  else groups.delete(groupId)
  await saveDisabledGroups(groups)
  return command.action === 'add' ? TEXT.blacklistAdded(groupId) : TEXT.blacklistDeleted(groupId)
}

// 将群号或频道号转换成安全文件名，避免运行时 ID 影响目录边界。
function safeScopeFileName(scopeId = '') {
  return encodeURIComponent(String(scopeId || 'global'))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

// 返回当前 scope 的新格式存储文件路径。
function getScopeFilePath(scopeId = '') {
  return path.join(SCOPE_DATA_DIR, `${safeScopeFileName(scopeId)}.json`)
}

// 将读取到的 scope 数据规整成插件内部稳定结构。
function normalizeScopeStore(scopeId, data) {
  const source = data && typeof data === 'object' ? data : {}
  const aliases = source.aliases && typeof source.aliases === 'object' ? source.aliases : {}
  return {
    version: Number(source.version || STORE_VERSION),
    scopeId: String(source.scopeId || scopeId || 'global'),
    aliases,
    updatedAt: source.updatedAt || '',
  }
}

// 按大小上限读取 JSON，避免异常大文件拖垮插件进程。
async function readJsonFileIfSmall(filePath, fallback) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > MAX_STORE_FILE_BYTES) throw new Error('store file too large')
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

// 加载旧版单文件总表；显式配置旧变量时继续作为主存储使用。
async function ensureLegacyStore() {
  if (legacyStoreLoaded) {
    if (legacyStoreLoadError) throw createStoreAccessError(TEXT.storeReadFailed, legacyStoreLoadError)
    return
  }
  try {
    const parsed = await readJsonFileIfSmall(LEGACY_DATA_FILE, null)
    if (parsed && typeof parsed === 'object') legacyNicknameStore = parsed
  } catch (error) {
    legacyStoreLoadError = error
    legacyStoreLoaded = true
    throw createStoreAccessError(TEXT.storeReadFailed, error)
  }

  if (!legacyNicknameStore.scopes || typeof legacyNicknameStore.scopes !== 'object') {
    legacyNicknameStore = { scopes: {} }
  }

  legacyStoreLoaded = true
}

// 从旧总表读取当前 scope，作为新目录模式的懒迁移来源。
async function readLegacyScopeStore(scopeId) {
  await ensureLegacyStore()
  const legacyScope = legacyNicknameStore.scopes[String(scopeId)]
  if (!legacyScope || typeof legacyScope !== 'object') return null
  return normalizeScopeStore(scopeId, legacyScope)
}

// 为旧版单文件模式排队写入，兼容显式 GROUP_NAME_AT_DATA_FILE 部署。
async function saveLegacyStore() {
  const task = legacySaveChain.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(LEGACY_DATA_FILE), { recursive: true })
    const tmp = `${LEGACY_DATA_FILE}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(legacyNicknameStore, null, 2), 'utf8')
    await fs.rename(tmp, LEGACY_DATA_FILE)
  })
  legacySaveChain = task.catch(() => {})
  try {
    await task
  } catch (error) {
    throw createStoreAccessError(TEXT.storeSaveFailed, error)
  }
}

// 为单个 scope 排队写入，确保同群并发更新不会互相覆盖。
async function enqueueScopeSave(scopeId, taskFn) {
  const queueKey = safeScopeFileName(scopeId)
  const previous = scopeSaveChains.get(queueKey) || Promise.resolve()
  const task = previous.catch(() => {}).then(taskFn)
  const cleanup = task.catch(() => {})
  scopeSaveChains.set(queueKey, cleanup)
  try {
    return await task
  } finally {
    if (scopeSaveChains.get(queueKey) === cleanup) scopeSaveChains.delete(queueKey)
  }
}

// 保存当前 scope 到新目录文件，使用临时文件加 rename 原子替换。
async function saveScopeStore(scopeId, scopeStore) {
  await enqueueScopeSave(scopeId, async () => {
    await fs.mkdir(SCOPE_DATA_DIR, { recursive: true })
    const file = getScopeFilePath(scopeId)
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    const data = normalizeScopeStore(scopeId, scopeStore)
    data.updatedAt = new Date().toISOString()
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, file)
    scopeStoreCache.set(String(scopeId), data)
  })
}

// 初始化当前存储模式；新目录模式只准备目录，不一次性加载所有群。
async function ensureStore() {
  if (USE_LEGACY_STORE) {
    await ensureLegacyStore()
    return
  }
  try {
    await fs.mkdir(SCOPE_DATA_DIR, { recursive: true })
  } catch (error) {
    throw createStoreAccessError(TEXT.storeReadFailed, error)
  }
}

// 按当前会话 scope 加载昵称集合；新目录缺失时从旧总表懒迁移。
async function getScopeStore(session) {
  const scopeId = getScopeId(session)
  if (USE_LEGACY_STORE) {
    await ensureLegacyStore()
    if (!legacyNicknameStore.scopes[scopeId]) legacyNicknameStore.scopes[scopeId] = { aliases: {} }
    if (!legacyNicknameStore.scopes[scopeId].aliases) legacyNicknameStore.scopes[scopeId].aliases = {}
    return legacyNicknameStore.scopes[scopeId]
  }

  if (scopeStoreCache.has(scopeId)) return scopeStoreCache.get(scopeId)

  try {
    let scopeStore = await readJsonFileIfSmall(getScopeFilePath(scopeId), null)
    if (!scopeStore) {
      scopeStore = await readLegacyScopeStore(scopeId)
      if (scopeStore) await saveScopeStore(scopeId, scopeStore)
    }
    const normalized = normalizeScopeStore(scopeId, scopeStore || { aliases: {} })
    scopeStoreCache.set(scopeId, normalized)
    return normalized
  } catch (error) {
    throw createStoreAccessError(TEXT.storeReadFailed, error)
  }
}

// 保存当前会话 scope；旧模式写总表，新模式只写当前群文件。
async function saveStore(session) {
  if (USE_LEGACY_STORE) {
    await saveLegacyStore()
    return
  }
  const scopeId = getScopeId(session)
  await saveScopeStore(scopeId, await getScopeStore(session))
}

function ensureAliasEntry(scopeStore, alias) {
  if (!scopeStore.aliases[alias]) scopeStore.aliases[alias] = { members: [] }
  if (!Array.isArray(scopeStore.aliases[alias].members)) scopeStore.aliases[alias].members = []
  return scopeStore.aliases[alias]
}

function getEntry(scopeStore, alias) {
  const entry = scopeStore.aliases[alias]
  if (!entry) return null
  if (!Array.isArray(entry.members)) entry.members = []
  return entry
}

function extractMentionIds(content = '') {
  const ids = []
  const text = String(content)
  const patterns = [
    /<at(?:\s+[^>]*?)?id="(\d+)"[^>]*\/?>/gi,
    /\[CQ:at,[^\]]*?(?:qq|id)=(\d+)[^\]]*\]/gi,
  ]

  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text))) {
      const userId = String(match[1])
      if (!ids.includes(userId)) ids.push(userId)
    }
  }

  return ids
}

function stripMentions(content = '') {
  return String(content)
    .replace(/<at(?:\s+[^>]*?)?id="\d+"[^>]*\/?>/gi, ' ')
    .replace(/\[CQ:at,[^\]]*?(?:qq|id)=\d+[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function readMemberByInternal(bot, guildId, userId) {
  const internal = bot?.internal
  const readers = [
    () => internal?.getGroupMemberInfo?.(guildId, userId, false),
    () => internal?.get_group_member_info?.({ group_id: guildId, user_id: userId, no_cache: false }),
  ]

  for (const read of readers) {
    try {
      const data = await read()
      if (data) return data
    } catch {}
  }

  return null
}

async function getDisplayName(session, userId) {
  const selfCandidate = session.event?.member?.nick || session.event?.member?.name || session.author?.nick || session.author?.name || session.username
  if (String(session.userId || '') === String(userId) && selfCandidate) return String(selfCandidate)

  const bot = session.bot
  const guildId = session.guildId
  const readers = [
    async () => bot?.getGuildMember?.(guildId, userId),
    async () => bot?.getGroupMember?.(guildId, userId),
    async () => readMemberByInternal(bot, guildId, userId),
    async () => bot?.getUser?.(userId),
  ]

  for (const read of readers) {
    try {
      const data = await read()
      const candidate = data?.card || data?.nick || data?.nickname || data?.name || data?.username || data?.user?.name
      if (candidate) return String(candidate)
    } catch {}
  }

  return ''
}

function formatMemberLabel(member) {
  const displayName = String(member.displayName || '').trim()
  if (displayName && displayName !== member.userId && displayName !== `QQ${member.userId}`) return displayName
  return segment.at(member.userId)
}

async function refreshMemberDisplayNames(session, members) {
  let changed = false
  for (const member of members) {
    const displayName = await getDisplayName(session, member.userId)
    if (!displayName || displayName === member.userId || displayName === `QQ${member.userId}`) continue
    if (member.displayName !== displayName) {
      member.displayName = displayName
      changed = true
    }
  }
  return changed
}

function buildAtMessage(members, tail) {
  const atPart = members.map((member) => segment.at(member.userId)).join('')
  return tail ? atPart + ' ' + tail : atPart
}

async function createMember(session, userId) {
  return {
    userId: String(userId),
    displayName: await getDisplayName(session, userId),
    createdBy: String(session.userId || ''),
    createdAt: new Date().toISOString(),
  }
}

async function addMembers(session, alias, userIds) {
  const scopeStore = await getScopeStore(session)
  const entry = ensureAliasEntry(scopeStore, alias)
  let added = 0

  for (const userId of userIds) {
    if (entry.members.some((member) => member.userId === String(userId))) continue
    entry.members.push(await createMember(session, userId))
    added += 1
  }

  return { entry, added }
}

async function bindAlias(session, alias, targetUserId) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = await getScopeStore(session)
  const entry = ensureAliasEntry(scopeStore, alias)
  const existing = entry.members.find((member) => member.userId === String(targetUserId))
  if (existing) return TEXT.aliasExists(alias)

  entry.members.push(await createMember(session, targetUserId))
  await saveStore(session)

  if (entry.members.length === 1) return TEXT.aliasAdded(alias)
  return TEXT.collectionAdded(alias, 1, entry.members.length)
}

async function removeAliasBinding(session, alias, targetUserId) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = await getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry || !entry.members.length) return TEXT.aliasNotFound(alias)

  const before = entry.members.length
  entry.members = entry.members.filter((member) => member.userId !== String(targetUserId))
  if (entry.members.length === before) return TEXT.aliasRemoveMissing(alias)

  if (!entry.members.length) {
    delete scopeStore.aliases[alias]
    await saveStore(session)
    return TEXT.aliasRemovedLast(alias)
  }

  await saveStore(session)
  return TEXT.aliasRemoved(alias, entry.members.length)
}

async function viewAlias(session, alias) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = await getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry) return TEXT.aliasNotFound(alias)

  const changed = await refreshMemberDisplayNames(session, entry.members)
  if (changed) await saveStore(session)

  const title = entry.members.length > 1 ? TEXT.collectionTitle(alias) : TEXT.aliasTitle(alias)
  const lines = entry.members.map((member, index) => `${index + 1}. ${formatMemberLabel(member)}`)
  return [title, TEXT.collectionCount(entry.members.length), ...lines].join('\n')
}

async function sendAliasMention(session, alias, tail) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return null

  const scopeStore = await getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry || !entry.members.length) return null

  const changed = await refreshMemberDisplayNames(session, entry.members)
  if (changed) await saveStore(session)
  return buildAtMessage(entry.members, tail)
}

async function listEntries(session, mode) {
  await ensureStore()
  const scopeStore = await getScopeStore(session)
  const entries = Object.entries(scopeStore.aliases)
    .map(([alias, entry]) => [alias, Array.isArray(entry.members) ? entry.members : []])
    .filter(([, members]) => mode === 'alias' ? members.length === 1 : members.length > 1)
    .sort((left, right) => left[0].localeCompare(right[0], 'zh-CN'))

  if (!entries.length) return mode === 'alias' ? TEXT.aliasListEmpty : TEXT.collectionListEmpty

  const lines = entries.map(([alias, members]) => `${alias} (${members.length})`)
  const title = mode === 'alias' ? TEXT.aliasListTitle : TEXT.collectionListTitle
  return [title, ...lines].join('\n')
}

async function createCollection(session, alias, userIds) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty
  if (!userIds.length) return TEXT.mentionRequired

  const scopeStore = await getScopeStore(session)
  if (scopeStore.aliases[alias]) return TEXT.targetExists(alias)

  const { entry } = await addMembers(session, alias, userIds)
  await saveStore(session)
  return TEXT.collectionCreated(alias, entry.members.length)
}

async function collectionAdd(session, alias, userIds) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty
  if (!userIds.length) return TEXT.mentionRequired

  const scopeStore = await getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry) return TEXT.aliasNotFound(alias)

  const { added } = await addMembers(session, alias, userIds)
  await saveStore(session)
  return TEXT.collectionAdded(alias, added, entry.members.length)
}

async function collectionRemove(session, alias, userIds) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty
  if (!userIds.length) return TEXT.mentionRequired

  const scopeStore = await getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry) return TEXT.aliasNotFound(alias)

  const removeSet = new Set(userIds.map(String))
  const before = entry.members.length
  entry.members = entry.members.filter((member) => !removeSet.has(member.userId))
  const removed = before - entry.members.length
  await saveStore(session)
  return TEXT.collectionRemoved(alias, removed, entry.members.length)
}

function confirmKey(session, action, alias) {
  return `${getScopeId(session)}:${session.userId || 'unknown'}:${action}:${alias}`
}

function askConfirm(session, action, alias) {
  trimPendingConfirms()
  const key = confirmKey(session, action, alias)
  pendingConfirms.set(key, Date.now() + CONFIRM_TIMEOUT)
  return false
}

function takeConfirm(session, action, alias) {
  trimPendingConfirms()
  const key = confirmKey(session, action, alias)
  const expiresAt = pendingConfirms.get(key)
  if (!expiresAt || expiresAt <= Date.now()) {
    pendingConfirms.delete(key)
    return false
  }
  pendingConfirms.delete(key)
  return true
}

function trimPendingConfirms(now = Date.now()) {
  for (const [key, expiresAt] of pendingConfirms) {
    if (Number(expiresAt || 0) <= now) pendingConfirms.delete(key)
  }
  if (pendingConfirms.size <= MAX_PENDING_CONFIRMS) return
  const ordered = Array.from(pendingConfirms.entries()).sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0))
  for (const [key] of ordered.slice(0, pendingConfirms.size - MAX_PENDING_CONFIRMS)) pendingConfirms.delete(key)
}

async function deleteCollection(session, alias, confirmed) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = await getScopeStore(session)
  if (!scopeStore.aliases[alias]) return TEXT.aliasNotFound(alias)
  if (confirmed && !takeConfirm(session, 'delete', alias)) return TEXT.confirmDelete(alias)
  if (!confirmed && !askConfirm(session, 'delete', alias)) return TEXT.confirmDelete(alias)

  delete scopeStore.aliases[alias]
  await saveStore(session)
  return TEXT.collectionDeleted(alias)
}

async function clearCollection(session, alias, confirmed) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = await getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry) return TEXT.aliasNotFound(alias)
  if (confirmed && !takeConfirm(session, 'clear', alias)) return TEXT.confirmClear(alias)
  if (!confirmed && !askConfirm(session, 'clear', alias)) return TEXT.confirmClear(alias)

  entry.members = []
  await saveStore(session)
  return TEXT.collectionCleared(alias)
}

async function renameEntry(session, from, to) {
  await ensureStore()
  from = normalizeName(from)
  to = normalizeName(to)
  if (!from || !to) return TEXT.aliasEmpty

  const scopeStore = await getScopeStore(session)
  if (!scopeStore.aliases[from]) return TEXT.aliasNotFound(from)
  if (scopeStore.aliases[to]) return TEXT.targetExists(to)

  scopeStore.aliases[to] = scopeStore.aliases[from]
  delete scopeStore.aliases[from]
  await saveStore(session)
  return TEXT.renameDone(from, to)
}

async function copyCollection(session, from, to) {
  await ensureStore()
  from = normalizeName(from)
  to = normalizeName(to)
  if (!from || !to) return TEXT.aliasEmpty

  const scopeStore = await getScopeStore(session)
  const entry = getEntry(scopeStore, from)
  if (!entry) return TEXT.aliasNotFound(from)
  if (scopeStore.aliases[to]) return TEXT.targetExists(to)

  scopeStore.aliases[to] = { members: entry.members.map((member) => ({ ...member })) }
  await saveStore(session)
  return TEXT.copied(from, to, entry.members.length)
}

async function mergeCollection(session, targetAlias, sourceAlias) {
  await ensureStore()
  targetAlias = normalizeName(targetAlias)
  sourceAlias = normalizeName(sourceAlias)
  if (!targetAlias || !sourceAlias) return TEXT.aliasEmpty

  const scopeStore = await getScopeStore(session)
  const target = getEntry(scopeStore, targetAlias)
  const source = getEntry(scopeStore, sourceAlias)
  if (!target) return TEXT.aliasNotFound(targetAlias)
  if (!source) return TEXT.aliasNotFound(sourceAlias)

  let added = 0
  for (const member of source.members) {
    if (target.members.some((item) => item.userId === member.userId)) continue
    target.members.push({ ...member })
    added += 1
  }

  await saveStore(session)
  return TEXT.merged(targetAlias, sourceAlias, added, target.members.length)
}

function memberMatches(member, keyword) {
  return member.userId === keyword || normalizeName(member.displayName).includes(keyword)
}

async function viewMember(session, keyword, mentionId) {
  await ensureStore()
  const scopeStore = await getScopeStore(session)
  const matched = []
  const target = mentionId ? String(mentionId) : normalizeName(keyword)
  if (!target) return TEXT.memberRequired

  let label = target
  for (const [alias, entry] of Object.entries(scopeStore.aliases)) {
    const members = Array.isArray(entry.members) ? entry.members : []
    const changed = await refreshMemberDisplayNames(session, members)
    if (changed) await saveStore(session)
    const member = members.find((item) => mentionId ? item.userId === target : memberMatches(item, target))
    if (member) {
      label = formatMemberLabel(member)
      matched.push(`${alias} (${members.length})`)
    }
  }

  if (!matched.length) return TEXT.memberNoAlias(label)
  return [TEXT.memberTitle(label), ...matched.sort((a, b) => a.localeCompare(b, 'zh-CN'))].join('\n')
}

async function collectionSet(session, left, right, type) {
  await ensureStore()
  left = normalizeName(left)
  right = normalizeName(right)
  const scopeStore = await getScopeStore(session)
  const leftEntry = getEntry(scopeStore, left)
  const rightEntry = getEntry(scopeStore, right)
  if (!leftEntry) return TEXT.aliasNotFound(left)
  if (!rightEntry) return TEXT.aliasNotFound(right)

  await refreshMemberDisplayNames(session, leftEntry.members)
  await refreshMemberDisplayNames(session, rightEntry.members)
  await saveStore(session)

  const rightIds = new Set(rightEntry.members.map((member) => member.userId))
  let members = []

  if (type === '交集') {
    members = leftEntry.members.filter((member) => rightIds.has(member.userId))
  } else if (type === '并集') {
    const byId = new Map()
    for (const member of [...leftEntry.members, ...rightEntry.members]) byId.set(member.userId, member)
    members = [...byId.values()]
  } else {
    members = leftEntry.members.filter((member) => !rightIds.has(member.userId))
  }

  const lines = members.map((member, index) => `${index + 1}. ${formatMemberLabel(member)}`)
  return [TEXT.setTitle(type, left, right), TEXT.collectionCount(members.length), ...lines].join('\n')
}

function parseAliasBind(content) {
  const mentionIds = extractMentionIds(content)
  if (!mentionIds.length) return null

  const plain = stripMentions(content)
  if (plain === CMD.alias) return null
  if (plain.startsWith(CMD.alias + ' ')) {
    const alias = normalizeName(plain.slice(CMD.alias.length))
    return alias ? { targetUserId: mentionIds[0], alias } : null
  }
  if (plain.startsWith(CMD.alias)) {
    const alias = normalizeName(plain.slice(CMD.alias.length))
    return alias ? { targetUserId: mentionIds[0], alias } : null
  }

  return null
}

function parseAliasDelete(content, session) {
  const mentionIds = extractMentionIds(content)
  const plain = stripMentions(content)
  const alias = afterCommand(plain, CMD.deleteAlias)
  if (alias === null) return null
  return {
    alias,
    targetUserId: mentionIds[0] || String(session.userId || ''),
  }
}

// 返回 at 后的原始文本（包含昵称+消息），由调用方再拆分
function parseAtAlias(content) {
  const plain = stripMentions(content)
  const match = plain.match(/^at\s*(.+)$/i)
  if (!match) return null
  return normalizeName(match[1])
}

// 从已有昵称中贪心匹配最长前缀，返回 { alias, tail } 或 null
async function resolveAtAlias(session, text) {
  await ensureStore()
  const scopeStore = await getScopeStore(session)
  const aliases = Object.keys(scopeStore.aliases)
  // 按昵称长度从长到短排序，优先匹配最长的
  aliases.sort((a, b) => b.length - a.length)
  const normalized = normalizeName(text)
  for (const alias of aliases) {
    if (normalized.startsWith(alias)) {
      const tail = normalized.slice(alias.length).trim()
      return { alias, tail }
    }
  }
  return null
}

async function handlePlainCommand(session, content) {
  const plain = stripMentions(content)
  const mentionIds = extractMentionIds(content)
  if (!plain) return null

  if (mentionIds.length && plain === CMD.alias) {
    return viewMember(session, '', mentionIds[0])
  }

  if (plain === CMD.viewAllAliases || /^nicklist$/i.test(plain)) {
    return listEntries(session, 'alias')
  }

  if (plain === CMD.viewAllCollections || plain === CMD.collectionList) {
    return listEntries(session, 'collection')
  }

  let value = afterCommand(plain, CMD.viewAlias)
  if (value !== null) return viewAlias(session, value)

  value = afterCommand(plain, CMD.viewCollection)
  if (value !== null) return viewAlias(session, value)

  value = afterCommand(plain, CMD.whoIs)
  if (value !== null) return viewAlias(session, value)

  value = afterCommand(plain, CMD.viewMember)
  if (value !== null) {
    return viewMember(session, value, mentionIds[0])
  }

  value = afterCommand(plain, CMD.createCollection)
  if (value !== null) return createCollection(session, value, mentionIds)

  value = afterCommand(plain, CMD.addCollection)
  if (value !== null) return collectionAdd(session, value, mentionIds)

  value = afterCommand(plain, CMD.removeCollection)
  if (value !== null) return collectionRemove(session, value, mentionIds)

  value = afterCommand(plain, CMD.confirmDeleteCollection)
  if (value !== null) return deleteCollection(session, value, true)

  value = afterCommand(plain, CMD.deleteCollection)
  if (value !== null) return deleteCollection(session, value, false)

  value = afterCommand(plain, CMD.confirmClearCollection)
  if (value !== null) return clearCollection(session, value, true)

  value = afterCommand(plain, CMD.clearCollection)
  if (value !== null) return clearCollection(session, value, false)

  for (const command of [CMD.renameCollection, CMD.renameAlias]) {
    const args = parseCommandPair(plain, command)
    if (args) return renameEntry(session, args[0], args[1])
  }

  const copyArgs = parseCommandPair(plain, CMD.copyCollection)
  if (copyArgs) return copyCollection(session, copyArgs[0], copyArgs[1])

  const mergeArgs = parseCommandPair(plain, CMD.mergeCollection)
  if (mergeArgs) return mergeCollection(session, mergeArgs[0], mergeArgs[1])

  const setCommands = [
    [CMD.intersectCollection, '交集'],
    [CMD.unionCollection, '并集'],
    [CMD.diffCollection, '差集'],
  ]

  for (const [command, type] of setCommands) {
    const args = parseCommandPair(plain, command)
    if (args) return collectionSet(session, args[0], args[1], type)
  }

  return null
}

exports.apply = (ctx) => {
  ctx.on('ready', async () => {
    try {
      await ensureStore()
      loadDisabledGroups(true)
      const storePath = USE_LEGACY_STORE ? LEGACY_DATA_FILE : SCOPE_DATA_DIR
      ctx.logger('group-name-at').info(`group-name-at ${PLUGIN_VERSION} loaded: ${storePath}`)
    } catch (error) {
      ctx.logger('group-name-at').warn(error.message)
    }
  })

  ctx.command('nicklist', 'list aliases in current group').action(async ({ session }) => {
    if (isBlacklistedGroup(session)) return

    try {
      await safeSendText(ctx, session, await listEntries(session, 'alias'))
      return
    } catch (error) {
      await safeSendText(ctx, session, handleStoreAccessError(ctx, error))
      return
    }
  })

  ctx.middleware(async (session, next) => {
    try {
      const content = session.content || ''

      const nicknameBlacklistCommand = parseNicknameBlacklistCommand(content)
      if (nicknameBlacklistCommand) {
        await safeSendText(ctx, session, await handleNicknameBlacklistCommand(session, nicknameBlacklistCommand))
        return
      }

      if (isBlacklistedGroup(session)) return next()

      const bindAction = parseAliasBind(content)
      if (bindAction) {
        await safeSendText(ctx, session, await bindAlias(session, bindAction.alias, bindAction.targetUserId))
        return
      }

      const deleteAction = parseAliasDelete(content, session)
      if (deleteAction) {
        await safeSendText(ctx, session, await removeAliasBinding(session, deleteAction.alias, deleteAction.targetUserId))
        return
      }

      const commandResult = await handlePlainCommand(session, content)
      if (commandResult) {
        await safeSendText(ctx, session, commandResult)
        return
      }

      const atRaw = parseAtAlias(content)
      if (atRaw) {
        const resolved = await resolveAtAlias(session, atRaw)
        if (resolved) {
          const atMessage = await sendAliasMention(session, resolved.alias, resolved.tail)
          if (atMessage) {
            await safeSendText(ctx, session, atMessage)
            return
          }
        }
        await safeSendText(ctx, session, TEXT.aliasNotFound(atRaw))
        return
      }

      return next()
    } catch (error) {
      await safeSendText(ctx, session, handleStoreAccessError(ctx, error))
      return
    }
  })
}

exports._test = {
  DATA_FILE,
  LEGACY_DATA_FILE,
  SCOPE_DATA_DIR,
  USE_LEGACY_STORE,
  DISABLED_GROUPS_FILE,
  ADMIN_IDS_FILE,
  pendingConfirms,
  trimPendingConfirms,
  loadDisabledGroups,
  parseNicknameBlacklistCommand,
  handleNicknameBlacklistCommand,
  safeSendText,
}
