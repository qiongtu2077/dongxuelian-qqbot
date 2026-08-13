// 为主控制台页面注册无副作用的只读响应。
function interceptCommonReads() {
  cy.intercept('GET', '**/dashboard/api/features', [])
  cy.intercept('GET', '**/dashboard/api/commands', [])
  cy.intercept('GET', '**/dashboard/api/status', {})
  cy.intercept('GET', '**/dashboard/api/bot/status', { running: false, workers: 0 })
  cy.intercept('GET', '**/dashboard/api/maintenance', { enabled: false })
  cy.intercept('GET', '**/dashboard/api/qq/ssh-info', { host: '', user: 'root' })
  cy.intercept('GET', '**/dashboard/api/qq/selfid', { selfId: '10000' })
  cy.intercept('GET', '**/dashboard/api/throttle', { maxPerMinute: 20 })
  cy.intercept('GET', '**/dashboard/api/providers', {
    deepseek: { name: 'DeepSeek', models: [{ id: 'chat' }, { id: 'vision', vision: true }, { id: 'lite' }] },
  })
  cy.intercept('GET', '**/dashboard/api/config', { provider: 'deepseek', model: 'chat', baseUrl: '' })
  cy.intercept('GET', '**/dashboard/api/fallback', {
    chains: {
      chat: [{ provider: 'deepseek', model: 'chat' }],
      vision: [{ provider: 'deepseek', model: 'vision' }],
      lightweight: [{ provider: 'deepseek', model: 'lite' }],
    },
    defaults: {
      chat: [{ provider: 'deepseek', model: 'chat' }],
      vision: [{ provider: 'deepseek', model: 'vision' }],
      lightweight: [{ provider: 'deepseek', model: 'lite' }],
    },
  })
  cy.intercept('GET', '**/dashboard/api/providers/custom', [])
}

// 以已登录且已跳过部署引导的状态进入主控制台。
function visitUnlockedDashboard() {
  cy.visit('', {
    onBeforeLoad(win) {
      win.localStorage.setItem('dashboard_token', 'e2e-access-token')
      win.localStorage.setItem('dashboard_deploy_unlocked', 'true')
      win.localStorage.setItem('dashboard_active_tab', 'features')
    },
  })
}

describe('主控制台按钮浏览器审查（排除独立 Agent 控制台）', () => {
  beforeEach(() => {
    interceptCommonReads()
  })

  it('已确认：解锁按钮只写浏览器状态就进入控制台', () => {
    cy.visit('', {
      onBeforeLoad(win) {
        win.localStorage.setItem('dashboard_token', 'e2e-access-token')
      },
    })

    cy.contains('button', '我已部署，解锁').click()
    cy.window().then(win => {
      expect(win.localStorage.getItem('dashboard_deploy_unlocked')).to.equal('true')
    })
    cy.contains('.active-view-label', '功能地图')
  })

  it('已确认：“测试 startBot API”会发出真实启动请求', () => {
    cy.intercept('POST', '**/dashboard/api/bot/start', { ok: true, message: '启动命令已发送' }).as('startBot')
    visitUnlockedDashboard()

    cy.contains('button', '终端控制').click()
    cy.contains('button', '测试 startBot API').click()
    cy.wait('@startBot').its('request.body').should('deep.equal', {})
  })

  it('已确认：模型页面出现三个会全量保存的 Fallback 保存按钮', () => {
    visitUnlockedDashboard()

    cy.contains('button', '模型配置').click()
    cy.contains('button', '保存 聊天 Fallback')
    cy.contains('button', '保存 视觉 Fallback')
    cy.contains('button', '保存 轻量功能 Fallback')
    cy.contains('主模型兜底（最后试一次主模型）')
  })

  it('不会进入或点击独立 Agent 控制台', () => {
    visitUnlockedDashboard()

    cy.location('pathname').should('eq', '/dashboard/')
    cy.get('a[href^="/agent/"]').should('not.exist')
  })
})
