const BASE = '/dashboard/api'
const SERVER_TOKEN_KEY = 'dashboard_server_token'
const LEGACY_ADMIN_TOKEN_KEY = 'dashboard_admin_token'

function getAdminToken() {
  try {
    const raw = localStorage.getItem(SERVER_TOKEN_KEY) || localStorage.getItem(LEGACY_ADMIN_TOKEN_KEY)
    if (!raw) return ''
    const { token, expires } = JSON.parse(raw)
    if (Date.now() > expires) { clearAdminToken(); return '' }
    return token
  } catch { return '' }
}

function setAdminToken(token) {
  // 1 小时有效期
  const data = JSON.stringify({ token, expires: Date.now() + 3600000 })
  localStorage.setItem(SERVER_TOKEN_KEY, data)
  localStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY)
}

function clearAdminToken() {
  localStorage.removeItem(SERVER_TOKEN_KEY)
  localStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY)
}

function headers(admin = false) {
  const h = { 'Content-Type': 'application/json' }
  const token = localStorage.getItem('dashboard_token')
  if (token) h['Authorization'] = 'Bearer ' + token
  if (admin) {
    const adminToken = getAdminToken()
    if (adminToken) h['X-Admin-Token'] = adminToken
  }
  return h
}

function handle401(res) {
  if (res.status === 401) {
    localStorage.removeItem('dashboard_token')
    // 抛出自定义事件，让 App.vue 去优雅处理退出，而不是暴力刷新
    window.dispatchEvent(new Event('auth-expired')) 
    return true
  }
  return false
}

function withTimeout(ms = 10000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) }
}

async function get(path, admin = false) {
  const { signal, clear } = withTimeout()
  try {
    const res = await fetch(BASE + path, { headers: headers(admin), signal })
    clear()
    if (res.status === 403) { const j = await res.json(); return { ok: false, data: j, code: j.code } }
    if (handle401(res)) return { ok: false, data: null }
    return { ok: res.ok, data: await res.json() }
  } catch (e) {
    clear()
    if (e.name === 'AbortError') return { ok: false, data: { message: '请求超时' } }
    return { ok: false, data: { message: e.message } }
  }
}

async function put(path, data, admin = false) {
  const { signal, clear } = withTimeout()
  try {
    const res = await fetch(BASE + path, { method: 'PUT', headers: headers(admin), body: JSON.stringify(data), signal })
    clear()
    if (res.status === 403) { const j = await res.json(); return { ok: false, data: j, code: j.code } }
    if (handle401(res)) return { ok: false, data: null }
    return { ok: res.ok, data: await res.json() }
  } catch (e) {
    clear()
    if (e.name === 'AbortError') return { ok: false, data: { message: '请求超时' } }
    return { ok: false, data: { message: e.message } }
  }
}

async function del(path, data, admin = false) {
  const { signal, clear } = withTimeout()
  try {
    const res = await fetch(BASE + path, { method: 'DELETE', headers: headers(admin), body: JSON.stringify(data), signal })
    clear()
    if (res.status === 403) { const j = await res.json(); return { ok: false, data: j, code: j.code } }
    if (handle401(res)) return { ok: false, data: null }
    return { ok: res.ok, data: await res.json() }
  } catch (e) {
    clear()
    if (e.name === 'AbortError') return { ok: false, data: { message: '请求超时' } }
    return { ok: false, data: { message: e.message } }
  }
}

async function post(path, data, admin = false) {
  const { signal, clear } = withTimeout()
  try {
    const res = await fetch(BASE + path, { method: 'POST', headers: headers(admin), body: JSON.stringify(data), signal })
    clear()
    if (res.status === 403) { const j = await res.json(); return { ok: false, data: j, code: j.code } }
    if (handle401(res)) return { ok: false, data: null }
    return { ok: res.ok, data: await res.json() }
  } catch (e) {
    clear()
    if (e.name === 'AbortError') return { ok: false, data: { message: '请求超时' } }
    return { ok: false, data: { message: e.message } }
  }
}

async function postPlain(path, data) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { ok: res.ok, data: await res.json() }
}

export async function login(password) { return postPlain('/login', { password }) }
export async function verifyAdmin(password) { return postPlain('/admin/verify', { password }) }
export async function changePassword(type, oldPassword, newPassword) { return put('/auth/password', { type, oldPassword, newPassword }, true) }
export async function resetPassword(resetToken) { return postPlain('/auth/reset-password', { resetToken }) }
export { setAdminToken, getAdminToken, clearAdminToken }
export async function fetchStatus() { return get('/status') }
export async function fetchProviders() { return get('/providers') }
export async function fetchConfig() { return get('/config') }
export async function updateConfig(data) { return put('/config', data, true) }
export async function fetchPersonas() { return get('/personas') }
export async function fetchPersonaDetail(name) { return get('/personas?name=' + encodeURIComponent(name)) }
export async function fetchModes() { return get('/modes') }
export async function fetchWhitelist() { return get('/whitelist') }
export async function updateWhitelist(type, data) { return put('/whitelist', { type, data }, true) }
export async function fetchKeys() { return get('/keys') }
export async function updateKey(file, value) { return put('/keys', { file, value }, true) }
export async function fetchFeatures() { return get('/features') }
export async function fetchCommands() { return get('/commands') }
export async function fetchLoreList() { return get('/lore-list') }
export async function createPersona(data) { return post('/personas', data, true) }
export async function updatePersona(data) { return put('/personas', data, true) }
export async function deletePersona(name) { return del('/personas', { name }, true) }
export async function fetchLores() { return get('/lores') }
export async function createLore(data) { return post('/lores', data, true) }
export async function updateLore(data) { return put('/lores', data, true) }
export async function deleteLore(name) { return del('/lores', { name }, true) }
export async function botStatus() { return get('/bot/status') }
export async function startBot() { return post('/bot/start', {}, true) }
export async function stopBot() { return post('/bot/stop', {}, true) }
export async function fetchMaintenance() { return get('/maintenance') }
export async function setMaintenance(enabled) { return put('/maintenance', { enabled }, true) }
export async function fetchQQToken() { return get('/qq/token', true) }
export async function fetchSSHInfo() { return get('/qq/ssh-info') }
export async function fetchSelfId() { return get('/qq/selfid') }
export async function updateSelfId(selfId) { return put('/qq/selfid', { selfId }, true) }
export async function fetchDeployConfig() { return get('/deploy/config') }
export async function updateDeployConfig(data) { return put('/deploy/config', data, true) }
export async function checkDeployUpdate() { return get('/deploy/check-update') }
export async function runDeploy(data) { return post('/deploy/run', data, true) }
export async function getDeployProgress(taskId) { return get('/deploy/progress/' + encodeURIComponent(taskId)) }
export async function confirmDeploy() { return post('/deploy/confirm', {}, true) }
export async function uploadDeploy(name, data) { return post('/deploy/upload', { name, data }, true) }
export async function deployLocal(data) { return post('/deploy/local', data, true) }
export async function checkLocalEnv() { return get('/env/check') }
export async function downloadNapcat(url) { return post('/deploy/napcat-download', { url }, true) }
export async function localBotStatus() { return get('/bot/local-status') }
export async function localBotStop() { return post('/bot/local-stop', {}, true) }
export async function rebuildFrontend() { return post('/frontend/rebuild', {}, true) }
export async function rebuildFrontendStatus() { return get('/frontend/rebuild-status') }
export async function fetchFallbackChains() { return get('/fallback') }
export async function saveFallbackChains(chains) { return put('/fallback', { chains }, true) }
export async function fetchCustomProviders() { return get('/providers/custom') }
export async function saveCustomProviders(data) { return put('/providers/custom', data, true) }
export async function fetchAdminIds() { return get('/admin-ids') }
export async function updateAdminIds(ids) { return put('/admin-ids', { ids }, true) }
export async function fetchThrottle() { return get('/throttle') }
export async function saveThrottle(data) { return put('/throttle', data, true) }
export async function fetchLogs(params = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) query.set(key, value.join(','))
    else query.set(key, String(value))
  }
  const suffix = query.toString() ? '?' + query.toString() : ''
  return get('/bot/activity' + suffix)
}
export async function fetchLoggingConfig() { return get('/logging') }
export async function saveLoggingConfig(data) { return put('/logging', data, true) }
