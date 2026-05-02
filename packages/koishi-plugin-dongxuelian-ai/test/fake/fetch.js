function makeResponse(item = {}) {
  const status = item.status || 200
  const ok = Object.prototype.hasOwnProperty.call(item, 'ok') ? !!item.ok : status >= 200 && status < 300
  const body = Object.prototype.hasOwnProperty.call(item, 'body') ? item.body : item.json
  const textBody = Object.prototype.hasOwnProperty.call(item, 'text')
    ? String(item.text)
    : typeof body === 'string'
    ? body
    : JSON.stringify(body === undefined ? {} : body)
  return {
    ok,
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-type') return item.contentType || (item.invalidJson ? 'text/html' : 'application/json')
        return null
      },
    },
    async json() {
      if (item.invalidJson) throw new SyntaxError('Unexpected token < in JSON')
      if (Object.prototype.hasOwnProperty.call(item, 'json')) return item.json
      if (typeof body === 'string') return JSON.parse(body)
      return body === undefined ? {} : body
    },
    async text() {
      return textBody
    },
  }
}

function mockFetch(initialQueue = []) {
  const queue = initialQueue.slice()
  const calls = []
  const fetch = async (url, options = {}) => {
    let requestBody = null
    try { requestBody = options.body ? JSON.parse(options.body) : null } catch { requestBody = options.body || null }
    calls.push({ url: String(url), options, requestBody })
    const item = queue.length ? queue.shift() : { status: 200, json: { choices: [{ message: { content: 'ok' } }] } }
    if (item.abortError) {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    }
    if (item.error) throw item.error instanceof Error ? item.error : new Error(String(item.error))
    return makeResponse(item)
  }
  return {
    fetch,
    calls,
    queue,
    push(...items) { queue.push(...items) },
  }
}

module.exports = { mockFetch }
