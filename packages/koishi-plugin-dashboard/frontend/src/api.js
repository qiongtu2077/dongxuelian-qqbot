const BASE = '/dashboard/api'
const ADMIN_TOKEN_KEY = 'dashboard_admin_token'

function getAdminToken() {
  try {
    const raw = localStorage.getItem(ADMIN_TOKEN_KEY)
    if (!raw) return ''
    const { token, expires } = JSON.parse(raw)
    if (Date.now() > expires) { localStorage.removeItem(ADMIN_TOKEN_KEY); return '' }
    return token
  } catch { return '' }
}

function setAdminToken(token) {
  // 1 小时有效期
  const data = JSON.stringify({ token, expires: Date.now() + 3600000 })
  localStorage.setItem(ADMIN_TOKEN_KEY, data)
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
    window.dispatchEvent(new CustomEvent('dashboard-auth-expired'))
    return true
  }
  return false
}

function authExpiredResult() {
  return { ok: false, data: { message: '登录已过期，请重新登录', code: 'AUTH_EXPIRED' }, code: 'AUTH_EXPIRED' }
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: headers() })
  if (handle401(res)) return authExpiredResult()
  return { ok: res.ok, data: await res.json() }
}

async function put(path, data, admin = false) {
  const res = await fetch(BASE + path, {
    method: 'PUT',
    headers: headers(admin),
    body: JSON.stringify(data),
  })
  if (res.status === 403) {
    const j = await res.json()
    return { ok: false, data: j, code: j.code }
  }
  if (handle401(res)) return authExpiredResult()
  return { ok: res.ok, data: await res.json() }
}

async function del(path, data, admin = false) {
  const res = await fetch(BASE + path, {
    method: 'DELETE',
    headers: headers(admin),
    body: JSON.stringify(data),
  })
  if (res.status === 403) {
    const j = await res.json()
    return { ok: false, data: j, code: j.code }
  }
  if (handle401(res)) return authExpiredResult()
  return { ok: res.ok, data: await res.json() }
}

async function post(path, data, admin = false) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: headers(admin),
    body: JSON.stringify(data),
  })
  if (res.status === 403) {
    const j = await res.json()
    return { ok: false, data: j, code: j.code }
  }
  if (handle401(res)) return authExpiredResult()
  return { ok: res.ok, data: await res.json() }
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
export { setAdminToken, getAdminToken }
export async function fetchStatus() { return get('/status') }
export async function fetchProviders() { return get('/providers') }
export async function fetchConfig() { return get('/config') }
export async function updateConfig(data) { return put('/config', data, true) }
export async function fetchPersonas() { return get('/personas') }
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
export async function fetchPersona(name) { return get('/personas?name=' + encodeURIComponent(name)) }
export async function fetchLores() { return get('/lores') }
export async function createLore(data) { return post('/lores', data, true) }
export async function updateLore(data) { return put('/lores', data, true) }
export async function deleteLore(name) { return del('/lores', { name }, true) }
export async function fetchDeployConfig() { return get('/deploy/config') }
export async function saveDeployConfig(data) { return put('/deploy/config', data, true) }
export async function runDeploy(data) { return post('/deploy/run', data, true) }
export async function fetchDeployProgress(taskId) { return get('/deploy/progress/' + encodeURIComponent(taskId)) }
export async function confirmDeployed() { return post('/deploy/confirm', {}, true) }
export async function botStatus() { return get('/bot/status') }
export async function startBot() { return post('/bot/start', {}, true) }
export async function stopBot() { return post('/bot/stop', {}, true) }
export async function fetchMaintenance() { return get('/maintenance') }
export async function setMaintenance(enabled) { return put('/maintenance', { enabled }, true) }
export async function fetchQQToken() { return get('/qq/token') }
export async function fetchSSHInfo() { return get('/qq/ssh-info') }
export async function fetchSelfId() { return get('/qq/selfid') }
export async function updateSelfId(selfId) { return put('/qq/selfid', { selfId }, true) }
