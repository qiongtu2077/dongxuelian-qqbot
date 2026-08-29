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
  cy.intercept('GET', '**/dashboard/api/env/check', {
    host: { platform: 'linux', arch: 'x64', hostname: 'source-host' },
    localDeployTarget: { platform: 'linux', arch: 'x64', canRunWindowsLocalDeploy: false, blockedReason: 'e2e backend is Linux' },
  })
  cy.intercept('GET', '**/dashboard/api/deploy/config', { server: 'root@target-host', appDir: '/srv/app', mode: 'update' })
}

// 以已登录且已跳过部署引导的状态进入主控制台。
function visitUnlockedDashboard() {
  cy.visit('', {
    onBeforeLoad(win) {
      win.localStorage.setItem('dashboard_token', 'e2e-access-token')
      win.localStorage.setItem('dashboard_deploy_guide_skipped', 'true')
      win.localStorage.setItem('dashboard_active_tab', 'features')
    },
  })
}

describe('主控制台按钮浏览器审查（排除独立 Agent 控制台）', () => {
  beforeEach(() => {
    interceptCommonReads()
  })

  it('旧部署解锁键只迁移一次并从浏览器存储删除', () => {
    cy.visit('', {
      onBeforeLoad(win) {
        win.localStorage.setItem('dashboard_token', 'e2e-access-token')
        win.localStorage.setItem('dashboard_deploy_unlocked', 'true')
      },
    })

    cy.window().then(win => {
      expect(win.localStorage.getItem('dashboard_deploy_guide_skipped')).to.equal('true')
      expect(win.localStorage.getItem('dashboard_deploy_unlocked')).to.equal(null)
    })
    cy.contains('.active-view-label', '功能地图')
  })

  it('跳过部署引导明确说明不检查或证明部署成功', () => {
    cy.visit('', {
      onBeforeLoad(win) {
        win.localStorage.setItem('dashboard_token', 'e2e-access-token')
      },
    })

    cy.contains('不会检查或证明机器人已经部署成功')
    cy.contains('button', '跳过部署引导并进入控制台').click()
    cy.window().then(win => {
      expect(win.localStorage.getItem('dashboard_deploy_guide_skipped')).to.equal('true')
    })
    cy.contains('.active-view-label', '功能地图')
  })

  it('只保留正常启动入口且点击后只发出一次启动请求', () => {
    cy.intercept('POST', '**/dashboard/api/bot/start', { ok: true, message: '启动命令已发送' }).as('startBot')
    visitUnlockedDashboard()

    cy.contains('button', '终端控制').click()
    cy.contains('测试 startBot API').should('not.exist')
    cy.contains('button', '启动引擎').click()
    cy.wait('@startBot').its('request.body').should('deep.equal', {})
  })

  it('模型页面只有一个备用链保存入口且没有无效兜底开关', () => {
    visitUnlockedDashboard()

    cy.contains('button', '模型配置').click()
    cy.contains('button', '保存全部备用链').should('have.length', 1)
    cy.contains('button', '保存 聊天 Fallback').should('not.exist')
    cy.contains('主模型兜底（最后试一次主模型）').should('not.exist')
  })

  it('远程发布必须先预览并确认且执行只提交预览编号', () => {
    const previewId = 'a'.repeat(32)
    cy.intercept('POST', '**/dashboard/api/deploy/preview', {
      previewId,
      expiresAt: Date.now() + 30 * 60 * 1000,
      canDeploy: true,
      blockers: [],
      source: { hostname: 'source-host', commit: 'b'.repeat(40), clean: true },
      target: { server: 'root@target-host', hostname: 'target-host', appDir: '/srv/app', availableBytes: 1024 * 1024 * 1024, release: { releaseId: 'old-release' } },
      release: { releaseId: 'new-release', totalBytes: 1024, fileCount: 10 },
      requiredBytes: 64 * 1024 * 1024,
      changes: { added: 1, modified: 2, removed: 0, unchanged: 7 },
    }).as('previewDeploy')
    cy.intercept('POST', '**/dashboard/api/deploy/run', { taskId: 'task123' }).as('runDeploy')
    cy.intercept('GET', '**/dashboard/api/deploy/progress/task123', { state: 'success', stage: 'complete', lines: ['done'] })
    visitUnlockedDashboard()

    cy.contains('button', '部署').click()
    cy.contains('button', '切换到远程 Linux 部署').click()
    cy.contains('button', '发布已确认预览').should('be.disabled')
    cy.contains('button', '生成部署预览').click()
    cy.wait('@previewDeploy')
    cy.contains('new-release')
    cy.contains('button', '发布已确认预览').should('be.disabled')
    cy.contains('label', '我确认目标主机、目录和短暂停机影响').find('input').check()
    cy.contains('button', '发布已确认预览').should('not.be.disabled').click()
    cy.wait('@runDeploy').its('request.body').should('deep.equal', { previewId, confirmed: true })
  })

  it('不会进入或点击独立 Agent 控制台', () => {
    visitUnlockedDashboard()

    cy.location('pathname').should('eq', '/dashboard/')
    cy.get('a[href^="/agent/"]').should('not.exist')
  })
})
