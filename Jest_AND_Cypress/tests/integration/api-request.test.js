import { addManagedGroup, deleteManagedGroup, detectAiModelCapabilities, fetchAiModelApiConfig, fetchGroupSettings, fetchResourceStatus, saveGroupSettings, updateSelfId, verifyAdmin } from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

// 创建足以模拟浏览器 fetch Response 的响应对象。
function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: jest.fn().mockResolvedValue(data) }
}

describe('主控制台 API 请求封装', () => {
  beforeEach(() => {
    localStorage.clear()
    global.fetch = jest.fn()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('模型配置读取使用真实 GET 路径并携带访问令牌', async () => {
    localStorage.setItem('dashboard_token', 'access-token')
    global.fetch.mockResolvedValue(response(200, { config: {}, catalog: [] }))

    const result = await fetchAiModelApiConfig()

    expect(result.ok).toBe(true)
    expect(global.fetch).toHaveBeenCalledWith('/dashboard/api/ai-model-api/config', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
    }))
    expect(global.fetch.mock.calls[0][1].method).toBeUndefined()
  })

  test('更换 QQ 号使用 PUT、访问令牌和管理员令牌', async () => {
    localStorage.setItem('dashboard_token', 'access-token')
    localStorage.setItem('dashboard_server_token', JSON.stringify({ token: 'admin-token', expires: Date.now() + 60000 }))
    global.fetch.mockResolvedValue(response(200, { ok: true }))

    await updateSelfId('123456')

    expect(global.fetch).toHaveBeenCalledWith('/dashboard/api/qq/selfid', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ selfId: '123456' }),
      headers: expect.objectContaining({ Authorization: 'Bearer access-token', 'X-Admin-Token': 'admin-token' }),
    }))
  })

  test('群添加、读取详情、保存和删除均使用约定路径并携带管理员令牌', async () => {
    localStorage.setItem('dashboard_token', 'access-token')
    localStorage.setItem('dashboard_server_token', JSON.stringify({ token: 'admin-token', expires: Date.now() + 60000 }))
    global.fetch.mockResolvedValue(response(200, { ok: true }))
    const draft = { groupId: '10001', name: '测试群', randomRate: 0, voiceRate: null }
    await addManagedGroup('10001')
    await fetchGroupSettings('10001')
    await saveGroupSettings(draft)
    await deleteManagedGroup('10001')
    expect(global.fetch.mock.calls.map(([url, options]) => [url, options.method || 'GET', options.body])).toEqual([
      ['/dashboard/api/groups', 'POST', JSON.stringify({ groupId: '10001' })],
      ['/dashboard/api/groups/detail?groupId=10001', 'GET', undefined],
      ['/dashboard/api/groups/detail', 'PUT', JSON.stringify(draft)],
      ['/dashboard/api/groups', 'DELETE', JSON.stringify({ groupId: '10001' })],
    ])
    for (const [, options] of global.fetch.mock.calls) expect(options.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer access-token', 'X-Admin-Token': 'admin-token' }))
  })

  test('访问令牌失效时清理登录状态并派发统一事件', async () => {
    localStorage.setItem('dashboard_token', 'expired-token')
    const listener = jest.fn()
    window.addEventListener('auth-expired', listener)
    global.fetch.mockResolvedValue(response(401, { message: 'expired' }))

    const result = await fetchAiModelApiConfig()

    expect(result.ok).toBe(false)
    expect(localStorage.getItem('dashboard_token')).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('auth-expired', listener)
  })

  test('离开资源页取消传输，迟到的 401 不清除当前登录', async () => {
    localStorage.setItem('dashboard_token', 'current-token')
    let resolveResponse
    global.fetch.mockReturnValueOnce(new Promise(resolve => { resolveResponse = resolve }))
    const controller = new AbortController()
    const pending = fetchResourceStatus(controller.signal)
    const fetchSignal = global.fetch.mock.calls[0][1].signal
    controller.abort()
    expect(fetchSignal.aborted).toBe(true)
    resolveResponse(response(401, { message: 'stale response' }))
    expect(await pending).toEqual({ ok: false, data: null })
    expect(localStorage.getItem('dashboard_token')).toBe('current-token')
  })

  test('管理员密码输错返回 403 时保留普通登录状态', async () => {
    localStorage.setItem('dashboard_token', 'valid-access-token')
    const listener = jest.fn()
    window.addEventListener('auth-expired', listener)
    global.fetch.mockResolvedValue(response(403, { ok: false, message: 'admin password is incorrect', code: 'ADMIN_PASSWORD_INCORRECT' }))

    const result = await verifyAdmin('wrong-admin-password')

    expect(result.ok).toBe(false)
    expect(result.code).toBe('ADMIN_PASSWORD_INCORRECT')
    expect(localStorage.getItem('dashboard_token')).toBe('valid-access-token')
    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener('auth-expired', listener)
  })

  test('能力检测允许两轮各 30 秒的请求完成，并在 90 秒时终止无响应请求', async () => {
    jest.useFakeTimers()
    try {
      global.fetch.mockImplementation((_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        setTimeout(() => resolve(response(200, { ok: true })), 61000)
      }))
      const pending = detectAiModelCapabilities('custom-test', 'model')
      await jest.advanceTimersByTimeAsync(60000)
      expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(false)
      await jest.advanceTimersByTimeAsync(1000)
      expect((await pending).ok).toBe(true)

      global.fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))
      const timedOut = detectAiModelCapabilities('custom-test', 'model')
      await jest.advanceTimersByTimeAsync(90000)
      expect((await timedOut).data.message).toBe('请求超时')
    } finally { jest.useRealTimers() }
  })
})
