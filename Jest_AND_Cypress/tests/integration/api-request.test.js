import { fetchFallbackChains, updateSelfId, verifyAdmin } from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

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

  test('Fallback 读取使用真实 GET 路径并携带访问令牌', async () => {
    localStorage.setItem('dashboard_token', 'access-token')
    global.fetch.mockResolvedValue(response(200, { chains: {}, defaults: {} }))

    const result = await fetchFallbackChains()

    expect(result.ok).toBe(true)
    expect(global.fetch).toHaveBeenCalledWith('/dashboard/api/fallback', expect.objectContaining({
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

  test('访问令牌失效时清理登录状态并派发统一事件', async () => {
    localStorage.setItem('dashboard_token', 'expired-token')
    const listener = jest.fn()
    window.addEventListener('auth-expired', listener)
    global.fetch.mockResolvedValue(response(401, { message: 'expired' }))

    const result = await fetchFallbackChains()

    expect(result.ok).toBe(false)
    expect(localStorage.getItem('dashboard_token')).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('auth-expired', listener)
  })

  test('已确认：管理员密码输错返回 401 时也会清理整个 Dashboard 登录状态', async () => {
    localStorage.setItem('dashboard_token', 'valid-access-token')
    const listener = jest.fn()
    window.addEventListener('auth-expired', listener)
    global.fetch.mockResolvedValue(response(401, { ok: false, message: 'admin password is incorrect' }))

    const result = await verifyAdmin('wrong-admin-password')

    expect(result.ok).toBe(false)
    expect(localStorage.getItem('dashboard_token')).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('auth-expired', listener)
  })
})
