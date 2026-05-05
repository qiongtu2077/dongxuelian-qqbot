const BASE = '/dashboard/api'

function headers() {
  const h = { 'Content-Type': 'application/json' }
  const token = localStorage.getItem('dashboard_token')
  if (token) h['Authorization'] = 'Bearer ' + token
  return h
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: headers() })
  if (res.status === 401) {
    localStorage.removeItem('dashboard_token')
    window.location.reload()
    return { ok: false, data: null }
  }
  return { ok: res.ok, data: await res.json() }
}

async function put(path, data) {
  const res = await fetch(BASE + path, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(data),
  })
  if (res.status === 401) {
    localStorage.removeItem('dashboard_token')
    window.location.reload()
    return { ok: false, data: null }
  }
  return { ok: res.ok, data: await res.json() }
}

async function post(path, data) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { ok: res.ok, data: await res.json() }
}

export async function login(password) { return post('/login', { password }) }
export async function fetchStatus() { return get('/status') }
export async function fetchProviders() { return get('/providers') }
export async function fetchConfig() { return get('/config') }
export async function updateConfig(data) { return put('/config', data) }
export async function fetchPersonas() { return get('/personas') }
export async function fetchModes() { return get('/modes') }
export async function fetchWhitelist() { return get('/whitelist') }
export async function updateWhitelist(type, data) { return put('/whitelist', { type, data }) }
export async function fetchKeys() { return get('/keys') }
export async function updateKey(file, value) { return put('/keys', { file, value }) }
export async function fetchFeatures() { return get('/features') }
export async function fetchCommands() { return get('/commands') }
export async function fetchLoreList() { return get('/lore-list') }
export async function createPersona(data) { return post('/personas', data) }
export async function botStatus() { return get('/bot/status') }
export async function startBot() { return post('/bot/start', {}) }
export async function stopBot() { return post('/bot/stop', {}) }
export async function fetchMaintenance() { return get('/maintenance') }
export async function setMaintenance(enabled) { return put('/maintenance', { enabled }) }
export async function fetchQQToken() { return get('/qq/token') }
export async function fetchSSHInfo() { return get('/qq/ssh-info') }
export async function fetchSelfId() { return get('/qq/selfid') }
export async function updateSelfId(selfId) { return put('/qq/selfid', { selfId }) }
