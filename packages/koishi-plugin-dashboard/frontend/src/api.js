const BASE = 'http://localhost:5150/dashboard/api'

async function get(path) {
  const res = await fetch(BASE + path)
  return { ok: res.ok, data: await res.json() }
}

async function put(path, data) {
  const res = await fetch(BASE + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { ok: res.ok, data: await res.json() }
}

export async function fetchStatus() { return get('/status') }
export async function fetchProviders() { return get('/providers') }
export async function fetchConfig() { return get('/config') }
export async function updateConfig(data) { return put('/config', data) }
export async function fetchPersonas() { return get('/personas') }
export async function fetchModes() { return get('/modes') }
export async function fetchWhitelist() { return get('/whitelist') }
export async function fetchKeys() { return get('/keys') }
export async function updateKey(file, value) { return put('/keys', { file, value }) }
export async function fetchFeatures() { return get('/features') }
