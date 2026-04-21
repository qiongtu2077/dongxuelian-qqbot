mkdir -p /root/koishi-app/node_modules/koishi-plugin-group-name-at/lib
cat > /root/koishi-app/node_modules/koishi-plugin-group-name-at/package.json <<'EOF'
{
  "name": "koishi-plugin-group-name-at",
  "version": "0.4.7",
  "main": "lib/index.js"
}
EOF
cat > /root/koishi-app/node_modules/koishi-plugin-group-name-at/lib/index.js <<'EOF'
const { segment } = require('koishi')
const fs = require('fs/promises')
const path = require('path')

exports.name = 'group-name-at'

const PLUGIN_VERSION = '0.4.7'
const DATA_FILE = '/root/koishi-app/data/nickname-collections.json'
const CONFIRM_TIMEOUT = 60 * 1000
//黑名单
const GROUP_BLACKLIST = new Set(['942033342
  //' '123456789',
])

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
}

let nicknameStore = { scopes: {} }
let storeLoaded = false
const pendingConfirms = new Map()

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
  return getGroupBlacklistCandidates(session).some(groupId => GROUP_BLACKLIST.has(groupId))
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
  const scopeStore = getScopeStore(session)
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

  const scopeStore = getScopeStore(session)
  const entry = ensureAliasEntry(scopeStore, alias)
  const existing = entry.members.find((member) => member.userId === String(targetUserId))
  if (existing) return TEXT.aliasExists(alias)

  entry.members.push(await createMember(session, targetUserId))
  await saveStore()

  if (entry.members.length === 1) return TEXT.aliasAdded(alias)
  return TEXT.collectionAdded(alias, 1, entry.members.length)
}

async function removeAliasBinding(session, alias, targetUserId) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry || !entry.members.length) return TEXT.aliasNotFound(alias)

  const before = entry.members.length
  entry.members = entry.members.filter((member) => member.userId !== String(targetUserId))
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
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry) return TEXT.aliasNotFound(alias)

  const changed = await refreshMemberDisplayNames(session, entry.members)
  if (changed) await saveStore()

  const title = entry.members.length > 1 ? TEXT.collectionTitle(alias) : TEXT.aliasTitle(alias)
  const lines = entry.members.map((member, index) => `${index + 1}. ${formatMemberLabel(member)}`)
  return [title, TEXT.collectionCount(entry.members.length), ...lines].join('\n')
}

async function sendAliasMention(session, alias, tail) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return null

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry || !entry.members.length) return null

  const changed = await refreshMemberDisplayNames(session, entry.members)
  if (changed) await saveStore()
  return buildAtMessage(entry.members, tail)
}

async function listEntries(session, mode) {
  await ensureStore()
  const scopeStore = getScopeStore(session)
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

  const scopeStore = getScopeStore(session)
  if (scopeStore.aliases[alias]) return TEXT.targetExists(alias)

  const { entry } = await addMembers(session, alias, userIds)
  await saveStore()
  return TEXT.collectionCreated(alias, entry.members.length)
}

async function collectionAdd(session, alias, userIds) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty
  if (!userIds.length) return TEXT.mentionRequired

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry) return TEXT.aliasNotFound(alias)

  const { added } = await addMembers(session, alias, userIds)
  await saveStore()
  return TEXT.collectionAdded(alias, added, entry.members.length)
}

async function collectionRemove(session, alias, userIds) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty
  if (!userIds.length) return TEXT.mentionRequired

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry) return TEXT.aliasNotFound(alias)

  const removeSet = new Set(userIds.map(String))
  const before = entry.members.length
  entry.members = entry.members.filter((member) => !removeSet.has(member.userId))
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
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  if (!scopeStore.aliases[alias]) return TEXT.aliasNotFound(alias)
  if (confirmed && !takeConfirm(session, 'delete', alias)) return TEXT.confirmDelete(alias)
  if (!confirmed && !askConfirm(session, 'delete', alias)) return TEXT.confirmDelete(alias)

  delete scopeStore.aliases[alias]
  await saveStore()
  return TEXT.collectionDeleted(alias)
}

async function clearCollection(session, alias, confirmed) {
  await ensureStore()
  alias = normalizeName(alias)
  if (!alias) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, alias)
  if (!entry) return TEXT.aliasNotFound(alias)
  if (confirmed && !takeConfirm(session, 'clear', alias)) return TEXT.confirmClear(alias)
  if (!confirmed && !askConfirm(session, 'clear', alias)) return TEXT.confirmClear(alias)

  entry.members = []
  await saveStore()
  return TEXT.collectionCleared(alias)
}

async function renameEntry(session, from, to) {
  await ensureStore()
  from = normalizeName(from)
  to = normalizeName(to)
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
  from = normalizeName(from)
  to = normalizeName(to)
  if (!from || !to) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
  const entry = getEntry(scopeStore, from)
  if (!entry) return TEXT.aliasNotFound(from)
  if (scopeStore.aliases[to]) return TEXT.targetExists(to)

  scopeStore.aliases[to] = { members: entry.members.map((member) => ({ ...member })) }
  await saveStore()
  return TEXT.copied(from, to, entry.members.length)
}

async function mergeCollection(session, targetAlias, sourceAlias) {
  await ensureStore()
  targetAlias = normalizeName(targetAlias)
  sourceAlias = normalizeName(sourceAlias)
  if (!targetAlias || !sourceAlias) return TEXT.aliasEmpty

  const scopeStore = getScopeStore(session)
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

  await saveStore()
  return TEXT.merged(targetAlias, sourceAlias, added, target.members.length)
}

function memberMatches(member, keyword) {
  return member.userId === keyword || normalizeName(member.displayName).includes(keyword)
}

async function viewMember(session, keyword, mentionId) {
  await ensureStore()
  const scopeStore = getScopeStore(session)
  const matched = []
  const target = mentionId ? String(mentionId) : normalizeName(keyword)
  if (!target) return TEXT.memberRequired

  let label = target
  for (const [alias, entry] of Object.entries(scopeStore.aliases)) {
    const members = Array.isArray(entry.members) ? entry.members : []
    const changed = await refreshMemberDisplayNames(session, members)
    if (changed) await saveStore()
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
  const scopeStore = getScopeStore(session)
  const leftEntry = getEntry(scopeStore, left)
  const rightEntry = getEntry(scopeStore, right)
  if (!leftEntry) return TEXT.aliasNotFound(left)
  if (!rightEntry) return TEXT.aliasNotFound(right)

  await refreshMemberDisplayNames(session, leftEntry.members)
  await refreshMemberDisplayNames(session, rightEntry.members)
  await saveStore()

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
  const scopeStore = getScopeStore(session)
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
  if (value) return viewAlias(session, value)

  value = afterCommand(plain, CMD.viewCollection)
  if (value) return viewAlias(session, value)

  value = afterCommand(plain, CMD.whoIs)
  if (value) return viewAlias(session, value)

  value = afterCommand(plain, CMD.viewMember)
  if (value || (mentionIds.length && plain === CMD.viewMember)) {
    return viewMember(session, value, mentionIds[0])
  }

  value = afterCommand(plain, CMD.createCollection)
  if (value) return createCollection(session, value, mentionIds)

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
      if (args.length >= 2) return renameEntry(session, args[0], args[1])
    }
  }

  value = afterCommand(plain, CMD.copyCollection)
  if (value) {
    const args = splitWords(value)
    if (args.length >= 2) return copyCollection(session, args[0], args[1])
  }

  value = afterCommand(plain, CMD.mergeCollection)
  if (value) {
    const args = splitWords(value)
    if (args.length >= 2) return mergeCollection(session, args[0], args[1])
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
    if (isBlacklistedGroup(session)) return

    return listEntries(session, 'alias')
  })

  ctx.middleware(async (session, next) => {
    if (isBlacklistedGroup(session)) return next()

    const content = session.content || ''

    const bindAction = parseAliasBind(content)
    if (bindAction) return bindAlias(session, bindAction.alias, bindAction.targetUserId)

    const deleteAction = parseAliasDelete(content, session)
    if (deleteAction) return removeAliasBinding(session, deleteAction.alias, deleteAction.targetUserId)

    const commandResult = await handlePlainCommand(session, content)
    if (commandResult) return commandResult

    const atRaw = parseAtAlias(content)
    if (atRaw) {
      const resolved = await resolveAtAlias(session, atRaw)
      if (resolved) {
        const atMessage = await sendAliasMention(session, resolved.alias, resolved.tail)
        if (atMessage) return atMessage
      }
      return TEXT.aliasNotFound(atRaw)
    }

    return next()
  })
}
EOF
printf '\nInstalled koishi-plugin-group-name-at 0.4.5\n'
systemctl restart koishi
