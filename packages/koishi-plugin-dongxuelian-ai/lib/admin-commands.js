/**
 * MODULE: 管理员内联命令处理。
 * 职责: 白名单/黑名单/概率/敏感/事件抓取等管理命令的匹配与执行。
 * 边界: 不调 AI API，不改对话历史，不拥有状态（通过参数接收可变引用）。
 */
const path = require('path')
const {
  RANDOM_WHITELIST_FILE, RANDOM_RATE_FILE,
  USER_BLACKLIST_FILE, VIDEO_BLACKLIST_FILE,
  SUMMARY_WHITELIST_FILE, EVENT_DUMP_DIR, EVENT_DUMP_ARM_EXPIRE_MS,
  POLITICAL_HANDLER_DIR, POLITICAL_DETECT_FILE,
  RANDOM_TRIGGER_RATE_BASE, RANDOM_TRIGGER_RAMP,
} = require('./constants')
const { readJsonFile, writeJsonFile, formatPercent, hasAdminPermission } = require('./utils')
const { isAdminUserId } = require('./runtime-config')
const { resetPoliticalDetectCache, clearSensitiveRuntimeState } = require('./sensitive')

async function handleAdminInlineCommands(session, ctx, {
  plain,
  inGuild,
  channelKey,
  isGroupAdmin,
  randomWhitelistCache,
  randomRateCache,
  loadUserBlacklist,
  getFileFingerprint,
  setBlacklistFingerprint,
  armEventDump,
  getArmedEventDump,
  clearArmedEventDump,
  getRandomWhitelistStatus,
}) {
  const matched = (response) => ({ matched: true, response })

  // 群聊AI白名单
  const whitelistAddMatch = plain.match(/^群聊AI白名单添加\s*(\d+)$/)
  if (whitelistAddMatch) {
    randomWhitelistCache.add(whitelistAddMatch[1])
    await writeJsonFile(RANDOM_WHITELIST_FILE, [...randomWhitelistCache])
    return matched(`已加入群聊AI白名单：${whitelistAddMatch[1]}`)
  }

  const whitelistDeleteMatch = plain.match(/^群聊AI白名单删除\s*(\d+)$/)
  if (whitelistDeleteMatch) {
    randomWhitelistCache.delete(whitelistDeleteMatch[1])
    await writeJsonFile(RANDOM_WHITELIST_FILE, [...randomWhitelistCache])
    return matched(`已移出群聊AI白名单：${whitelistDeleteMatch[1]}`)
  }

  if (/^群聊AI白名单(?:查看|列表)$/.test(plain)) {
    const whitelist = [...randomWhitelistCache]
    return matched(whitelist.length ? `群聊AI白名单：\n${whitelist.join('\n')}` : '当前白名单为空，等同于所有群都禁止主动回复。')
  }

  // 用户黑名单
  const userBlAdd = plain.match(/^用户黑名单添加\s*(\d+)$/)
  if (userBlAdd) {
    const uid = userBlAdd[1]
    if (isAdminUserId(uid)) return matched('不能对管理员添加黑名单。')
    const cache = await loadUserBlacklist()
    cache.add(uid)
    await writeJsonFile(USER_BLACKLIST_FILE, [...cache])
    setBlacklistFingerprint(await getFileFingerprint(USER_BLACKLIST_FILE))
    return matched(`已添加用户黑名单：${uid}`)
  }
  const userBlDel = plain.match(/^用户黑名单删除\s*(\d+)$/)
  if (userBlDel) {
    const cache = await loadUserBlacklist()
    cache.delete(userBlDel[1])
    await writeJsonFile(USER_BLACKLIST_FILE, [...cache])
    setBlacklistFingerprint(await getFileFingerprint(USER_BLACKLIST_FILE))
    return matched(`已移出用户黑名单：${userBlDel[1]}`)
  }
  if (plain === '用户黑名单查看') {
    const cache = await loadUserBlacklist()
    const list = [...cache]
    return matched(list.length ? `用户黑名单：\n${list.join('\n')}` : '用户黑名单为空。')
  }

  // 视频黑名单
  const vidBlAddG = plain.match(/^视频黑名单添加群\s*(\d+)$/)
  if (vidBlAddG) {
    if (!inGuild) return matched('这个命令只能在群里使用。')
    if (!isGroupAdmin && !hasAdminPermission(session)) return matched('只有群主、管理员或bot管理员才能操作。')
    const bl = await readJsonFile(VIDEO_BLACKLIST_FILE, { groups: [], users: [] })
    if (!Array.isArray(bl.groups)) bl.groups = []
    if (!bl.groups.includes(vidBlAddG[1])) bl.groups.push(vidBlAddG[1])
    await writeJsonFile(VIDEO_BLACKLIST_FILE, bl)
    return matched(`视频解析已加入群黑名单：${vidBlAddG[1]}`)
  }
  const vidBlDelG = plain.match(/^视频黑名单删除群\s*(\d+)$/)
  if (vidBlDelG) {
    if (!inGuild) return matched('这个命令只能在群里使用。')
    if (!isGroupAdmin && !hasAdminPermission(session)) return matched('只有群主、管理员或bot管理员才能操作。')
    const bl = await readJsonFile(VIDEO_BLACKLIST_FILE, { groups: [], users: [] })
    if (Array.isArray(bl.groups)) bl.groups = bl.groups.filter(g => g !== vidBlDelG[1])
    await writeJsonFile(VIDEO_BLACKLIST_FILE, bl)
    return matched(`视频解析已移出群黑名单：${vidBlDelG[1]}`)
  }
  if (plain === '视频黑名单查看') {
    const bl = await readJsonFile(VIDEO_BLACKLIST_FILE, { groups: [], users: [] })
    if (Array.isArray(bl.groups) && bl.groups.length) return matched(`视频黑名单群：\n${bl.groups.join('\n')}`)
    return matched('视频群黑名单为空。')
  }

  // 敏感话题处理者
  const safeChannelKeyStr = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
  const handlerFile = path.join(POLITICAL_HANDLER_DIR, safeChannelKeyStr + '.json')

  const handlerAdd = plain.match(/^敏感话题处理者添加\s*(\d+)$/)
  if (handlerAdd) {
    if (!inGuild) return matched('这个命令只能在群里使用。')
    if (!isGroupAdmin && !hasAdminPermission(session)) return matched('只有群主、管理员或bot管理员才能设置处理者。')
    let list = await readJsonFile(handlerFile, [])
    if (!Array.isArray(list)) { await writeJsonFile(handlerFile, [handlerAdd[1]]); return matched(`已添加敏感话题处理者：${handlerAdd[1]}`) }
    if (!list.includes(handlerAdd[1])) { list.push(handlerAdd[1]); await writeJsonFile(handlerFile, list) }
    return matched(`已添加敏感话题处理者：${handlerAdd[1]}`)
  }
  const handlerDel = plain.match(/^敏感话题处理者删除\s*(\d+)$/)
  if (handlerDel) {
    if (!inGuild) return matched('这个命令只能在群里使用。')
    if (!isGroupAdmin && !hasAdminPermission(session)) return matched('只有群主、管理员或bot管理员才能设置处理者。')
    let list = await readJsonFile(handlerFile, [])
    if (Array.isArray(list)) { list = list.filter(id => id !== handlerDel[1]); await writeJsonFile(handlerFile, list) }
    return matched(`已移除敏感话题处理者：${handlerDel[1]}`)
  }
  if (plain === '敏感话题处理者查看') {
    if (!inGuild) return matched('这个命令只能在群里使用。')
    const list = await readJsonFile(handlerFile, [])
    if (Array.isArray(list) && list.length) return matched(`本群敏感话题处理者：\n${list.join('\n')}`)
    return matched('本群未配置敏感话题处理者。')
  }

  // 敏感话题检测开关
  if (plain === '敏感话题检测开') {
    if (!inGuild) return matched('这个命令只能在群里使用。')
    if (!isGroupAdmin && !hasAdminPermission(session)) return matched('只有群主、管理员或bot管理员才能操作。')
    let list = await readJsonFile(POLITICAL_DETECT_FILE, [])
    if (!Array.isArray(list)) list = []
    if (!list.includes(channelKey)) { list.push(channelKey); await writeJsonFile(POLITICAL_DETECT_FILE, list) }
    resetPoliticalDetectCache()
    clearSensitiveRuntimeState(channelKey)
    let sw = await readJsonFile(SUMMARY_WHITELIST_FILE, [])
    if (!Array.isArray(sw)) sw = []
    if (!sw.includes(channelKey)) { sw.push(channelKey); await writeJsonFile(SUMMARY_WHITELIST_FILE, sw) }
    return matched('敏感话题检测已开启。')
  }
  if (plain === '敏感话题检测关') {
    if (!inGuild) return matched('这个命令只能在群里使用。')
    if (!isGroupAdmin && !hasAdminPermission(session)) return matched('只有群主、管理员或bot管理员才能操作。')
    let list = await readJsonFile(POLITICAL_DETECT_FILE, [])
    if (Array.isArray(list)) { list = list.filter(k => k !== channelKey); await writeJsonFile(POLITICAL_DETECT_FILE, list) }
    resetPoliticalDetectCache()
    clearSensitiveRuntimeState(channelKey)
    return matched('敏感话题检测已关闭。')
  }
  if (plain === '敏感话题检测查看') {
    const list = await readJsonFile(POLITICAL_DETECT_FILE, [])
    return matched(`敏感话题检测：${Array.isArray(list) && list.includes(channelKey) ? '开' : '关'}`)
  }

  // 解除上限群白名单管理
  const swAdd = plain.match(/^解除上限群白名单添加\s*(\d+)$/)
  if (swAdd) {
    const sw = await readJsonFile(SUMMARY_WHITELIST_FILE, [])
    if (!Array.isArray(sw)) { await writeJsonFile(SUMMARY_WHITELIST_FILE, [swAdd[1]]); return matched(`已添加解除上限群白名单：${swAdd[1]}`) }
    if (!sw.includes(swAdd[1])) { sw.push(swAdd[1]); await writeJsonFile(SUMMARY_WHITELIST_FILE, sw) }
    return matched(`已添加解除上限群白名单：${swAdd[1]}`)
  }
  const swDel = plain.match(/^解除上限群白名单删除\s*(\d+)$/)
  if (swDel) {
    let sw = await readJsonFile(SUMMARY_WHITELIST_FILE, [])
    if (Array.isArray(sw)) { sw = sw.filter(g => g !== swDel[1]); await writeJsonFile(SUMMARY_WHITELIST_FILE, sw) }
    return matched(`已移出解除上限群白名单：${swDel[1]}`)
  }
  if (plain === '解除上限群白名单查看') {
    const sw = await readJsonFile(SUMMARY_WHITELIST_FILE, [])
    if (Array.isArray(sw) && sw.length) return matched(`解除上限群白名单：\n${sw.join('\n')}`)
    return matched('解除上限群白名单为空。')
  }

  // AI抓事件
  if (plain === 'AI抓事件') {
    armEventDump(session)
    return matched(`已开始抓取当前会话的下一条原始事件。\n请把目标消息再发一遍，触发后会写入：${EVENT_DUMP_DIR}`)
  }
  if (plain === 'AI抓事件查看') {
    const armed = getArmedEventDump(channelKey)
    if (!armed) return matched('当前没有待抓取的原始事件。')
    return matched(`原始事件抓取：已开启\n抓取人：${armed.armedBy || '(未知)'}\n剩余有效期：约${Math.max(1, Math.ceil((EVENT_DUMP_ARM_EXPIRE_MS - (Date.now() - armed.armedAt)) / 60000))}分钟`)
  }
  if (plain === 'AI抓事件取消') {
    clearArmedEventDump(channelKey)
    return matched('已取消当前会话的原始事件抓取。')
  }

  // 概率设置/重置
  const rateSetMatch = plain.match(/^东雪莲群聊AI概率设置\s*((?:100(?:\.0+)?)|(?:\d{1,2}(?:\.\d+)?))%$/)
  if (rateSetMatch) {
    if (!inGuild) return matched('这个命令只能在群里用。')
    if (!isGroupAdmin && !hasAdminPermission(session)) return matched('只有群主、群管理员或bot管理员才能设置概率。')
    const rate = Number(rateSetMatch[1]) / 100
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1) return matched('概率范围只能是 0% 到 100% 之间。')
    randomRateCache.set(channelKey, rate)
    await writeJsonFile(RANDOM_RATE_FILE, Object.fromEntries(randomRateCache))
    return matched(`本群主动回复基础概率已设置为 ${formatPercent(rate)}。50条未触发后仍按每条 +${formatPercent(RANDOM_TRIGGER_RAMP)} 递增。本群东雪莲AI聊天状态：${getRandomWhitelistStatus(channelKey) ? '开' : '关'}`)
  }
  if (/^东雪莲群聊AI概率重置$/.test(plain)) {
    if (!inGuild) return matched('这个命令只能在群里用。')
    randomRateCache.delete(channelKey)
    await writeJsonFile(RANDOM_RATE_FILE, Object.fromEntries(randomRateCache))
    return matched(`本群主动回复基础概率已重置为默认值 ${formatPercent(RANDOM_TRIGGER_RATE_BASE)}。`)
  }

  return { matched: false }
}

module.exports = { handleAdminInlineCommands }
