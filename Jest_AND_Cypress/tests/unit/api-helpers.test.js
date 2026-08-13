import { clearAdminToken, getAdminToken, isAdminRequired, setAdminToken } from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

describe('主控制台 API 辅助逻辑', () => {
  beforeEach(() => {
    localStorage.clear()
    jest.restoreAllMocks()
  })

  test('同时识别顶层和 data 内的 ADMIN_REQUIRED', () => {
    expect(isAdminRequired({ code: 'ADMIN_REQUIRED' })).toBe(true)
    expect(isAdminRequired({ data: { code: 'ADMIN_REQUIRED' } })).toBe(true)
    expect(isAdminRequired({ code: 'OTHER' })).toBe(false)
    expect(isAdminRequired(null)).toBe(false)
  })

  test('管理员令牌写入统一键并清理旧键', () => {
    localStorage.setItem('dashboard_admin_token', JSON.stringify({ token: 'legacy', expires: Date.now() + 10000 }))

    setAdminToken('fresh-token')

    expect(getAdminToken()).toBe('fresh-token')
    expect(localStorage.getItem('dashboard_admin_token')).toBeNull()
    clearAdminToken()
    expect(getAdminToken()).toBe('')
  })

  test('过期管理员令牌会被拒绝并删除', () => {
    localStorage.setItem('dashboard_server_token', JSON.stringify({ token: 'expired', expires: Date.now() - 1 }))

    expect(getAdminToken()).toBe('')
    expect(localStorage.getItem('dashboard_server_token')).toBeNull()
  })
})
