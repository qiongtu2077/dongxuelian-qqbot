/**
 * MODULE: pet-bridge protocol handlers.
 * 职责: Dispatch and handle all pet bridge WebSocket message types (query/command/chat).
 * 边界: Reads config through runtime-config; calls AI through api.js.
 *        Does NOT modify core plugin logic, handle Koishi sessions, or send messages on its own.
 */
const { loadConfig, resetConfigCache, getThinkingEnabled, setThinkingEnabled } = require('koishi-plugin-dongxuelian-ai/lib/runtime-config')
const { requestChatCompletions } = require('koishi-plugin-dongxuelian-ai/lib/api')
const { getAvailablePersonals, loadPersonalSkill, setUserPersona, getUserPersona } = require('koishi-plugin-dongxuelian-ai/lib/persona')
const { getMemorySummary } = require('koishi-plugin-dongxuelian-ai/lib/conversation')
const { PROVIDER_FILE, MODEL_FILE, SEARCH_ENABLED_FILE, MAINTENANCE_FILE, THINKING_MODE_FILE, SUMMARY_WHITELIST_FILE, RANDOM_WHITELIST_FILE } = require('koishi-plugin-dongxuelian-ai/lib/constants')
const fs = require('fs')



function readJsonFileSync(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return fallback }
}

function writeJsonFileSync(filePath, data) {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
}

function writeTextFileSync(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8')
}

function callOneBot(action, params) {
  return new Promise((resolve) => {
    let ws = null
    let timer = null
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { if (ws) ws.close() } catch {}
      resolve(value)
    }
    try {
      ws = new (require('ws'))('ws://127.0.0.1:8080/onebot/v11/ws')
      timer = setTimeout(() => finish(null), 5000)
      ws.on('open', () => {
        try { ws.send(JSON.stringify({ action, params, echo: 'pet-bridge' })) } catch { finish(null) }
      })
      ws.on('message', (d) => {
        let msg = null
        try { msg = JSON.parse(d.toString()) } catch { return finish(null) }
        if (msg.status === 'ok') finish(msg)
        else finish(null)
      })
      ws.on('error', (e) => { console.error('[pet-bridge] callOneBot WS error:', e.message); finish(null) })
      ws.on('close', () => finish(null))
    } catch (e) { console.error('[pet-bridge] callOneBot connect error:', e.message); finish(null) }
  })
}

async function handleStatus() {
  const config = await loadConfig()
  return {
    success: true,
    payload: {
      provider: config.provider,
      model: config.model,
      baseURL: config.baseURL,
      online: true,
      searchEnabled: config.searchEnabled,
      thinkingEnabled: getThinkingEnabled(),
    },
  }
}

function handlePersonas() {
  const personas = getAvailablePersonals()
  return { success: true, payload: { personas } }
}

async function handleMemory(payload) {
  const { userId, channelKey } = payload
  if (!userId) return { success: false, payload: { error: 'missing userId' } }
  const summary = await getMemorySummary(userId, channelKey || 'default')
  return { success: true, payload: { summary } }
}

function handleSummaries() {
  const whitelist = readJsonFileSync(SUMMARY_WHITELIST_FILE, [])
  return { success: true, payload: { groups: Array.isArray(whitelist) ? whitelist : [] } }
}

async function handleSwitchModel(payload) {
  const { provider, model } = payload
  if (provider) writeTextFileSync(PROVIDER_FILE, provider)
  if (model) writeTextFileSync(MODEL_FILE, model)
  resetConfigCache()
  const config = await loadConfig(true)
  return { success: true, payload: { provider: config.provider, model: config.model } }
}

function handleToggleSearch(payload) {
  const enabled = !!payload.enabled
  writeTextFileSync(SEARCH_ENABLED_FILE, enabled ? '1' : '0')
  resetConfigCache()
  return { success: true, payload: { searchEnabled: enabled } }
}

function handleToggleThinking(payload) {
  const enabled = !!payload.enabled
  setThinkingEnabled(enabled)
  writeTextFileSync(THINKING_MODE_FILE, enabled ? '1' : '0')
  return { success: true, payload: { thinkingEnabled: enabled } }
}

function handleToggleMaintenance(payload) {
  const enabled = !!payload.enabled
  if (enabled) {
    writeTextFileSync(MAINTENANCE_FILE, '优化中，别急~')
  } else {
    try { fs.unlinkSync(MAINTENANCE_FILE) } catch {}
  }
  return { success: true, payload: { maintenanceEnabled: enabled } }
}

async function handleSendGroupMsg(payload) {
  const { groupId, text } = payload
  if (!groupId || !text) return { success: false, payload: { error: 'missing groupId or text' } }
  const result = await callOneBot('send_group_msg', { group_id: Number(groupId), message: text })
  return { success: !!result, payload: result || { error: 'send failed' } }
}

function handleManageWhitelist(payload) {
  const op = payload.whitelistAction || payload.action
  const groupId = payload.groupId
  let list = readJsonFileSync(RANDOM_WHITELIST_FILE, [])
  if (!Array.isArray(list)) list = []
  if (op === 'add') {
    const gid = String(groupId || '')
    if (!gid) return { success: false, payload: { error: 'missing groupId' } }
    if (!list.includes(gid)) list.push(gid)
    writeJsonFileSync(RANDOM_WHITELIST_FILE, list)
    return { success: true, payload: { whitelist: list } }
  }
  if (op === 'remove') {
    const gid = String(groupId || '')
    if (!gid) return { success: false, payload: { error: 'missing groupId' } }
    list = list.filter(id => id !== gid)
    writeJsonFileSync(RANDOM_WHITELIST_FILE, list)
    return { success: true, payload: { whitelist: list } }
  }
  if (op === 'list') {
    return { success: true, payload: { whitelist: list } }
  }
  return { success: false, payload: { error: 'invalid action; use add/remove/list' } }
}

function handleSwitchPersona(payload) {
  const { name } = payload
  if (!name) return { success: false, payload: { error: 'missing persona name' } }
  const skill = loadPersonalSkill(name)
  if (!skill) return { success: false, payload: { error: 'persona not found' } }
  setUserPersona('desktop-user', name)
  return { success: true, payload: { persona: name } }
}

function handleGetCurrentPersona() {
  const current = getUserPersona('desktop-user') || 'default'
  return { success: true, payload: { persona: current } }
}

async function handleChat(payload) {
  const { text, persona } = payload
  if (!text) return { success: false, payload: { error: 'missing text' } }

  // 维护模式检查：与 bot index.js 逻辑一致
  if (require('fs').existsSync(MAINTENANCE_FILE)) {
    const mt = require('fs').readFileSync(MAINTENANCE_FILE, 'utf8').trim() || '优化中，别急~'
    return { success: true, payload: { reply: mt } }
  }

  const config = await loadConfig()
  const messages = []
  const personaName = persona || getUserPersona('desktop-user') || null
  if (personaName && personaName !== 'default') {
    const skillContent = loadPersonalSkill(personaName)
    if (skillContent) {
      const body = skillContent.replace(/^---[\s\S]*?---\n?/, '').trim()
      if (body) messages.push({ role: 'system', content: body })
    }
  }
  if (!messages.length) {
    messages.push({ role: 'system', content: '你是一个AI助手。请用简洁、自然的中文回答。' })
  }
  messages.push({ role: 'user', content: text })
  const extraBody = {}
  if (config.searchEnabled) extraBody.enable_search = true
  if (getThinkingEnabled()) extraBody.enable_thinking = true
  try {
    const reply = await requestChatCompletions(messages, config, extraBody)
    return { success: true, payload: { reply } }
  } catch (err) {
    return { success: false, payload: { error: err.message } }
  }
}

async function handleMessage(msg) {
  const { id, type, payload } = msg
  let result = null
  try {
    if (type === 'query') {
      const qt = payload && payload.type
      if (qt === 'status') result = await handleStatus()
      else if (qt === 'personas') result = handlePersonas()
      else if (qt === 'memory') result = await handleMemory(payload)
      else if (qt === 'summaries') result = handleSummaries()
      else if (qt === 'current_persona') result = handleGetCurrentPersona()
      else result = { success: false, payload: { error: 'unknown query type: ' + qt } }
    } else if (type === 'command') {
      const action = payload && payload.action
      if (action === 'switch_model') result = await handleSwitchModel(payload)
      else if (action === 'toggle_search') result = handleToggleSearch(payload)
      else if (action === 'toggle_thinking') result = handleToggleThinking(payload)
      else if (action === 'toggle_maintenance') result = handleToggleMaintenance(payload)
      else if (action === 'send_group_msg') result = await handleSendGroupMsg(payload)
      else if (action === 'manage_whitelist') result = handleManageWhitelist(payload)
      else if (action === 'switch_persona') result = handleSwitchPersona(payload)
      else result = { success: false, payload: { error: 'unknown command: ' + action } }
    } else if (type === 'chat') {
      result = await handleChat(payload)
    } else {
      result = { success: false, payload: { error: 'unknown message type: ' + type } }
    }
  } catch (err) {
    result = { success: false, payload: { error: err.message } }
  }
  return { type: 'response', id: id != null ? id : null, ...result }
}

module.exports = { handleMessage }
