mkdir -p /root/koishi-app/node_modules/koishi-plugin-group-name-at/lib
cat > /root/koishi-app/node_modules/koishi-plugin-group-name-at/package.json <<'EOF'
{
  "name": "koishi-plugin-group-name-at",
  "version": "0.4.2",
  "main": "lib/index.js"
}
EOF
cat > /root/koishi-app/node_modules/koishi-plugin-group-name-at/lib/index.js <<'EOF'
const { segment } = require('koishi')
const fs = require('fs/promises')
const path = require('path')

exports.name = 'group-name-at'

const PLUGIN_VERSION = '0.4.2'
const DATA_FILE = '/root/koishi-app/data/nickname-collections.json'
const CONFIRM_TIMEOUT = 60 * 1000

const CMD = {
  alias: '昵称',
  deleteAlias: '删除昵称',
  viewAlias: '查看昵称',
  viewCollection: '查看集合',
  viewAllAliases: '查看全部昵称',
  viewAllCollections: '查看全部集合',
  collectionList: '集合列表',
  whoIs: '谁是',
  deleteCollection: '删除集合',
  confirmDeleteCollection: '确认删除集合',
  createCollection: '创建集合',
  mergeCollection: '合并集合',
  addCollection: '集合添加',
  removeCollection: '集合删除',
  clearCollection: '清空集合',
  confirmClearCollection: '确认清空集合',
  renameCollection: '重命名集合',
  renameAlias: '重命名昵称',
  viewMember: '查看成员',
  copyCollection: '复制集合',
  intersectCollection: '集合交集',
  unionCollection: '集合并集',
  diffCollection: '集合差集',
}

const TEXT = {
  aliasEmpty: '昵称不能为空。',
  mentionRequired: '请至少 @ 一个成员。',
  aliasNotFound: (alias) => `没有找到「${alias}」。`,
  aliasExists: (alias, label) => `「${alias}」已经绑定到 ${label}，无需重复添加。`,
  aliasAdded: (alias, label) => `已为 ${label} 添加昵称「${alias}」。`,
  collectionUpgraded: (alias, label, count) => `已将${label}加入集合「${alias}」，已自动升级为集合，当前共 ${count} 人。`,
  collectionAdded: (alias, label, count, added) => `已将 ${added} 人加入集合「${alias}」，当前共 ${count} 人。`,
  aliasRemoveMissing: (alias) => `「${alias}」下没有绑定该成员。`,
  aliasRemovedLast: (alias) => `已删除「${alias}」的最后一个成员绑定。`,
  aliasRemoved: (alias, count) => `已从「${alias}」中移除该成员，当前剩余 ${count} 人。`,
  aliasListTitle: '本群昵称 / 集合：',
  aliasListEmpty: '本群还没有昵称或集合。',
  collectionTitle: (alias) => `集合：${alias}`,
  collectionCount: (count) => `人数：${count}`,
  collectionExists: (alias) => `集合「${alias}」已存在。要添加成员请用：集合添加 ${alias} @成员`,
  collectionCreated: (alias, count) => `已创建集合「${alias}」，当前共 ${count} 人。`,
  collectionMerged: (alias, added, count) => `已合并 ${added} 人到集合「${alias}」，当前共 ${count} 人。`,
  collectionMergedFrom: (target, source, added, count) => `已将集合「${source}」合并到「${target}」，新增 ${added} 人，「${target}」当前共 ${count} 人。`,
  collectionRemoved: (alias, removed, count) => `已从集合「${alias}」移除 ${removed} 人，当前剩余 ${count} 人。`,
  collectionCleared: (alias) => `已清空集合「${alias}」。`,
  collectionDeleted: (alias) => `已删除集合「${alias}」。`,
  renameDone: (from, to) => `已将「${from}」重命名为「${to}」。`,
  targetExists: (to) => `「${to}」已存在，不能覆盖。`,
  copied: (from, to, count) => `已复制集合「${from}」为「${to}」，共 ${count} 人。`,
  confirmDelete: (alias) => `确认删除集合 ${alias}`,
  confirmClear: (alias) => `确认清空集合 ${alias}`,
  needConfirmDelete: (alias) => `危险操作：再次发送「确认删除集合 ${alias}」即可删除整个集合，60 秒内有效。`,
  needConfirmClear: (alias) => `危险操作：再次发送「确认清空集合 ${alias}」即可清空成员，60 秒内有效。`,
  memberNoAlias: (label) => `${label} 暂时没有昵称，也不在任何集合里。`,
  memberTitle: (label) => `${label} 的昵称 / 集合：`,
  setTitle: (type, left, right) => `${type}：${left} / ${right}`,
}

let nicknameStore = { scopes: {} }
let storeLoaded = false
const pendingConfirms = new Map()

function getScopeId(session) {
  return String(session.guildId || session.channelId || 'global')
}

function normalizeAliasName(name = '') {
  return String(name).replace(/\s+/g, ' ').trim()
}

function splitWords(text = '') {
  return normalizeAliasName(text).split(' ').filter(Boolean)
}

function startsWithCommand(input, command) {
  return input === command || input.startsWith(`${command} `)
}

function afterCommand(input, command) {
  if (!startsWithCommand(input, command)) return null
  return normalizeAliasName(input.slice(command.length))
}

async function ensureStore() {
  if (storeLoaded) return

  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') nicknameStore = parsed
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  if (!nicknameStore.scopes || typeof nicknameStore.scopes !== 'object') {
    nicknameStore = { scopes: {} }
  }

  storeLoaded = true
}

async function saveStore() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true })
  await fs.writeFile(DATA_FILE, JSON.stringify(nicknameStore, null, 2), 'utf8')
}

function getScopeStore(session) {
  const scopeId = getScopeId(session)
  if (!nicknameStore.scopes[scopeId]) nicknameStore.scopes[scopeId] = { aliases: {} }
  if (!nicknameStore.scopes[scopeId].aliases) nicknameStore.scopes[scopeId].aliases = {}
  return nicknameStore.scopes[scopeId]
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
  if (String(session.userId || '') === String(userId) && selfCandidate) return selfCandidate

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

function buildAtMessage(members) {
  return members.map(member => segment.at(member.userId)).join('')
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
  const scopeStore = getScopeStore(session)
  const entry = ensureAliasEntry(scopeStore, alias)
  let added = 0
  let lastMember = null

  for (const userId of userIds) {
    if (entry.members.some(member => member.userId === String(userId))) continue
    lastMember = await createMember(session, userId)
    entry.members.push(lastMember)
    added += 1
  }

  return { entry, added, lastMember }
}

async function bindAlias(session, alias, targetUserId) {
  await ensureStore()

  alias = normalizeAliasName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  const entry = ensureAliasEntry(scopeStore, alias)
  const existing = entry.members.find(member => member.userId === String(targetUserId))
  if (existing) {
    const changed = await refreshMemberDisplayNames(session, [existing])
    if (changed) await saveStore()
    return TEXT.aliasExists(alias, formatMemberLabel(existing))
  }

  const before = entry.members.length
  const member = await createMember(session, targetUserId)
  entry.members.push(member)
  await saveStore()

  if (entry.members.length === 1) return TEXT.aliasAdded(alias, formatMemberLabel(member))
  if (before === 1 && entry.members.length === 2) return TEXT.collectionUpgraded(alias, formatMemberLabel(member), entry.members.length)
  return TEXT.collectionAdded(alias, formatMemberLabel(member), entry.members.length, 1)
}

async function removeAliasBinding(session, alias, targetUserId) {
  await ensureStore()

  alias = normalizeAliasName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry || !entry.members.length) return TEXT.aliasNotFound(alias)

  const before = entry.members.length
  entry.members = entry.members.filter(member => member.userId !== String(targetUserId))
  if (entry.members.length === before) return TEXT.aliasRemoveMissing(alias)

  if (!entry.members.length) {
    delete scopeStore.aliases[alias]
    await saveStore()
    return TEXT.aliasRemovedLast(alias)
  }

  await saveStore()
  return TEXT.aliasRemoved(alias, entry.members.length)
}

async function viewAlias(session, alias) {
  await ensureStore()

  alias = normalizeAliasName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry) return TEXT.aliasNotFound(alias)

  const changed = await refreshMemberDisplayNames(session, entry.members)
  if (changed) await saveStore()

  const lines = entry.members.map((member, index) => `${index + 1}. ${formatMemberLabel(member)}`)
  return [TEXT.collectionTitle(alias), TEXT.collectionCount(entry.members.length), ...lines].join('\n')
}

async function sendAliasMention(session, alias) {
  await ensureStore()

  alias = normalizeAliasName(alias)
  if (!alias) return null

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry || !entry.members.length) return null

  const changed = await refreshMemberDisplayNames(session, entry.members)
  if (changed) await saveStore()

  return buildAtMessage(entry.members)
}

async function listAliases(session) {
  await ensureStore()
  const scopeStore = getScopeStore(session)
  const aliases = Object.entries(scopeStore.aliases)
  if (!aliases.length) return TEXT.aliasListEmpty

  const lines = aliases
    .sort((left, right) => left[0].localeCompare(right[0], 'zh-CN'))
    .map(([alias, entry]) => `${alias} (${Array.isArray(entry.members) ? entry.members.length : 0})`)

  return [TEXT.aliasListTitle, ...lines].join('\n')
}

async function createCollection(session, alias, userIds, merge) {
  await ensureStore()
  alias = normalizeAliasName(alias)
  if (!alias) return TEXT.aliasEmpty
  if (!userIds.length) return TEXT.mentionRequired

  const scopeStore = getScopeStore(session)
  const exists = !!scopeStore.aliases[alias]
  if (exists && !merge) return TEXT.collectionExists(alias)

  const { entry, added } = await addMembers(session, alias, userIds)
  await saveStore()

  if (!exists) return TEXT.collectionCreated(alias, entry.members.length)
  return TEXT.collectionMerged(alias, added, entry.members.length)
}

async function mergeCollections(session, targetAlias, sourceAlias) {
  await ensureStore()
  targetAlias = normalizeAliasName(targetAlias)
  sourceAlias = normalizeAliasName(sourceAlias)
  if (!targetAlias || !sourceAlias) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  const targetEntry = getEntry(scopeStore, targetAlias)
  const sourceEntry = getEntry(scopeStore, sourceAlias)
  if (!targetEntry) return TEXT.aliasNotFound(targetAlias)
  if (!sourceEntry) return TEXT.aliasNotFound(sourceAlias)

  let added = 0
  for (const member of sourceEntry.members) {
    if (targetEntry.members.some(item => item.userId === member.userId)) continue
    targetEntry.members.push({ ...member })
    added += 1
  }

  await saveStore()
  return TEXT.collectionMergedFrom(targetAlias, sourceAlias, added, targetEntry.members.length)
}

async function collectionAdd(session, alias, userIds) {
  await ensureStore()
  alias = normalizeAliasName(alias)
  if (!alias) return TEXT.aliasEmpty
  if (!userIds.length) return TEXT.mentionRequired

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry) return TEXT.aliasNotFound(alias)

  const before = entry.members.length
  const result = await addMembers(session, alias, userIds)
  await saveStore()

  if (before === 1 && result.entry.members.length === 2 && result.lastMember) {
    return TEXT.collectionUpgraded(alias, formatMemberLabel(result.lastMember), result.entry.members.length)
  }
  return TEXT.collectionAdded(alias, formatMemberLabel(result.lastMember || { userId: '', displayName: '0' }), result.entry.members.length, result.added)
}

async function collectionRemove(session, alias, userIds) {
  await ensureStore()
  alias = normalizeAliasName(alias)
  if (!alias) return TEXT.aliasEmpty
  if (!userIds.length) return TEXT.mentionRequired

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry) return TEXT.aliasNotFound(alias)

  const removeSet = new Set(userIds.map(String))
  const before = entry.members.length
  entry.members = entry.members.filter(member => !removeSet.has(member.userId))
  const removed = before - entry.members.length
  await saveStore()

  return TEXT.collectionRemoved(alias, removed, entry.members.length)
}

function confirmKey(session, action, alias) {
  return `${getScopeId(session)}:${session.userId || 'unknown'}:${action}:${alias}`
}

function askConfirm(session, action, alias) {
  const key = confirmKey(session, action, alias)
  const now = Date.now()
  const old = pendingConfirms.get(key)
  if (old && old > now) {
    pendingConfirms.delete(key)
    return true
  }
  pendingConfirms.set(key, now + CONFIRM_TIMEOUT)
  return false
}

function takeConfirm(session, action, alias) {
  const key = confirmKey(session, action, alias)
  const expiresAt = pendingConfirms.get(key)
  if (!expiresAt || expiresAt <= Date.now()) {
    pendingConfirms.delete(key)
    return false
  }
  pendingConfirms.delete(key)
  return true
}

async function deleteCollection(session, alias, confirmed) {
  await ensureStore()
  alias = normalizeAliasName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  if (!scopeStore.aliases[alias]) return TEXT.aliasNotFound(alias)
  if (confirmed && !takeConfirm(session, 'delete', alias)) return TEXT.needConfirmDelete(alias)
  if (!confirmed && !askConfirm(session, 'delete', alias)) return TEXT.needConfirmDelete(alias)

  delete scopeStore.aliases[alias]
  await saveStore()
  return TEXT.collectionDeleted(alias)
}

async function clearCollection(session, alias, confirmed) {
  await ensureStore()
  alias = normalizeAliasName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry) return TEXT.aliasNotFound(alias)
  if (confirmed && !takeConfirm(session, 'clear', alias)) return TEXT.needConfirmClear(alias)
  if (!confirmed && !askConfirm(session, 'clear', alias)) return TEXT.needConfirmClear(alias)

  entry.members = []
  await saveStore()
  return TEXT.collectionCleared(alias)
}

async function renameAlias(session, from, to) {
  await ensureStore()
  from = normalizeAliasName(from)
  to = normalizeAliasName(to)
  if (!from || !to) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  if (!scopeStore.aliases[from]) return TEXT.aliasNotFound(from)
  if (scopeStore.aliases[to]) return TEXT.targetExists(to)

  scopeStore.aliases[to] = scopeStore.aliases[from]
  delete scopeStore.aliases[from]
  await saveStore()
  return TEXT.renameDone(from, to)
}

async function copyCollection(session, from, to) {
  await ensureStore()
  from = normalizeAliasName(from)
  to = normalizeAliasName(to)
  if (!from || !to) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, from)
  if (!entry) return TEXT.aliasNotFound(from)
  if (scopeStore.aliases[to]) return TEXT.targetExists(to)

  scopeStore.aliases[to] = { members: entry.members.map(member => ({ ...member })) }
  await saveStore()
  return TEXT.copied(from, to, entry.members.length)
}

function memberMatches(member, keyword) {
  return member.userId === keyword || normalizeAliasName(member.displayName).includes(keyword)
}

async function viewMember(session, keyword, mentionId) {
  await ensureStore()
  const scopeStore = getScopeStore(session)
  const matched = []
  const target = mentionId ? String(mentionId) : normalizeAliasName(keyword)
  if (!target) return '请指定成员名或 @ 一个成员。'

  let label = target
  for (const [alias, entry] of Object.entries(scopeStore.aliases)) {
    const members = Array.isArray(entry.members) ? entry.members : []
    const changed = await refreshMemberDisplayNames(session, members)
    if (changed) await saveStore()
    const member = members.find(item => mentionId ? item.userId === target : memberMatches(item, target))
    if (member) {
      label = formatMemberLabel(member)
      matched.push(`${alias} (${members.length})`)
    }
  }

  if (!matched.length) return TEXT.memberNoAlias(label)
  return [TEXT.memberTitle(label), ...matched.sort((left, right) => left.localeCompare(right, 'zh-CN'))].join('\n')
}

async function collectionSet(session, left, right, type) {
  await ensureStore()
  const scopeStore = getScopeStore(session)
  const leftEntry = getEntry(scopeStore, left)
  const rightEntry = getEntry(scopeStore, right)
  if (!leftEntry) return TEXT.aliasNotFound(left)
  if (!rightEntry) return TEXT.aliasNotFound(right)

  await refreshMemberDisplayNames(session, leftEntry.members)
  await refreshMemberDisplayNames(session, rightEntry.members)
  await saveStore()

  const rightIds = new Set(rightEntry.members.map(member => member.userId))
  const leftIds = new Set(leftEntry.members.map(member => member.userId))
  let members

  if (type === '交集') members = leftEntry.members.filter(member => rightIds.has(member.userId))
  if (type === '并集') {
    const byId = new Map()
    for (const member of [...leftEntry.members, ...rightEntry.members]) byId.set(member.userId, member)
    members = [...byId.values()]
  }
  if (type === '差集') members = leftEntry.members.filter(member => !rightIds.has(member.userId))

  const lines = members.map((member, index) => `${index + 1}. ${formatMemberLabel(member)}`)
  return [TEXT.setTitle(type, left, right), TEXT.collectionCount(members.length), ...lines].join('\n')
}

function parseAliasBind(content) {
  const mentionIds = extractMentionIds(content)
  if (!mentionIds.length) return null

  const plain = stripMentions(content)
  const alias = afterCommand(plain, CMD.alias)
  if (!alias) return null

  return { targetUserId: mentionIds[0], alias }
}

function parseAliasDelete(content, session) {
  const mentionIds = extractMentionIds(content)
  const plain = stripMentions(content)
  const alias = afterCommand(plain, CMD.deleteAlias)
  if (!alias) return null

  return {
    alias,
    targetUserId: mentionIds[0] || String(session.userId || ''),
  }
}

function parseAtAlias(content) {
  const plain = stripMentions(content)
  const match = plain.match(/^at\s*(.+)$/i)
  if (!match) return null
  return normalizeAliasName(match[1])
}

async function handlePlainCommand(session, content) {
  const plain = stripMentions(content)
  const mentionIds = extractMentionIds(content)

  if (!plain) return null

  if (mentionIds.length && plain === CMD.alias) {
    return viewMember(session, '', mentionIds[0])
  }

  if (plain === CMD.viewAllAliases || plain === CMD.viewAllCollections || plain === CMD.collectionList || /^nicklist$/i.test(plain)) {
    return listAliases(session)
  }

  for (const command of [CMD.viewCollection, CMD.viewAlias, CMD.whoIs]) {
    const alias = afterCommand(plain, command)
    if (alias) return viewAlias(session, alias)
  }

  let value = afterCommand(plain, CMD.viewMember)
  if (value || (mentionIds.length && plain === CMD.viewMember)) {
    return viewMember(session, value, mentionIds[0])
  }

  value = afterCommand(plain, CMD.createCollection)
  if (value) return createCollection(session, value, mentionIds, false)

  value = afterCommand(plain, CMD.mergeCollection)
  if (value) {
    const args = splitWords(value)
    if (args.length >= 2) return mergeCollections(session, args[0], args[1])
  }

  value = afterCommand(plain, CMD.addCollection)
  if (value) return collectionAdd(session, value, mentionIds)

  value = afterCommand(plain, CMD.removeCollection)
  if (value) return collectionRemove(session, value, mentionIds)

  value = afterCommand(plain, CMD.confirmDeleteCollection)
  if (value) return deleteCollection(session, value, true)

  value = afterCommand(plain, CMD.deleteCollection)
  if (value) return deleteCollection(session, value, false)

  value = afterCommand(plain, CMD.confirmClearCollection)
  if (value) return clearCollection(session, value, true)

  value = afterCommand(plain, CMD.clearCollection)
  if (value) return clearCollection(session, value, false)

  for (const command of [CMD.renameCollection, CMD.renameAlias]) {
    value = afterCommand(plain, command)
    if (value) {
      const args = splitWords(value)
      if (args.length >= 2) return renameAlias(session, args[0], args[1])
    }
  }

  value = afterCommand(plain, CMD.copyCollection)
  if (value) {
    const args = splitWords(value)
    if (args.length >= 2) return copyCollection(session, args[0], args[1])
  }

  const setCommands = [
    [CMD.intersectCollection, '交集'],
    [CMD.unionCollection, '并集'],
    [CMD.diffCollection, '差集'],
  ]
  for (const [command, type] of setCommands) {
    value = afterCommand(plain, command)
    if (value) {
      const args = splitWords(value)
      if (args.length >= 2) return collectionSet(session, args[0], args[1], type)
    }
  }

  return null
}

exports.apply = (ctx) => {
  ctx.on('ready', async () => {
    try {
      await ensureStore()
      ctx.logger('group-name-at').info(`group-name-at ${PLUGIN_VERSION} loaded: ${DATA_FILE}`)
    } catch (error) {
      ctx.logger('group-name-at').warn(error.message)
    }
  })

  ctx.command('nicklist', 'list aliases in current group').action(async ({ session }) => {
    return listAliases(session)
  })

  ctx.middleware(async (session, next) => {
    const content = session.content || ''

    const bindAction = parseAliasBind(content)
    if (bindAction) return bindAlias(session, bindAction.alias, bindAction.targetUserId)

    const deleteAction = parseAliasDelete(content, session)
    if (deleteAction) return removeAliasBinding(session, deleteAction.alias, deleteAction.targetUserId)

    const commandResult = await handlePlainCommand(session, content)
    if (commandResult) return commandResult

    const atAlias = parseAtAlias(content)
    if (atAlias) {
      const atMessage = await sendAliasMention(session, atAlias)
      if (atMessage) return atMessage
      return TEXT.aliasNotFound(atAlias)
    }

    return next()
  })
}
EOF
printf '\nInstalled koishi-plugin-group-name-at 0.4.2\n'
systemctl restart koishi
