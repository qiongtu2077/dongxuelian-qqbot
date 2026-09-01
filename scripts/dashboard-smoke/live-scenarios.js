const {
  LIVE_URL,
  LIVE_PASSWORD,
  LIVE_TOKEN,
  LIVE_ADMIN_TOKEN,
} = require('./runtime')
const {
  waitForText,
  hasText,
  clickText,
  ensureSidebarExpanded,
  clickSidebarTab,
  clickButtonByLabel,
  verifyAdminIfVisible,
  typePlaceholder,
} = require('./browser-helpers')
const { verifyResourcePanel } = require('./mock-scenarios')

/** Runs the non-destructive click-smoke scenario against a live Dashboard. */
async function runLiveClicks(page) {
  if (!LIVE_PASSWORD && !LIVE_TOKEN) throw new Error('DASHBOARD_SMOKE_PASSWORD or DASHBOARD_SMOKE_TOKEN is required for live smoke')
  await page.goto(LIVE_URL, { waitUntil: 'networkidle0' })
  if (LIVE_TOKEN) {
    await page.evaluate(token => {
      localStorage.setItem('dashboard_token', token)
      localStorage.removeItem('dashboard_deploy_unlocked')
      localStorage.setItem('dashboard_sidebar_expanded', 'true')
    }, LIVE_TOKEN)
    if (LIVE_ADMIN_TOKEN) {
      await page.evaluate(token => {
        localStorage.setItem('dashboard_server_token', JSON.stringify({ token, expires: Date.now() + 3600000 }))
      }, LIVE_ADMIN_TOKEN)
    }
    await page.reload({ waitUntil: 'networkidle0' })
  }
  if (await hasText(page, '请输入访问密码以继续')) {
    await typePlaceholder(page, '密码', LIVE_PASSWORD)
    await clickText(page, '登录')
  }
  await waitForText(page, 'LianBoard 控制中心', 15000)
  if (await hasText(page, '先完成部署')) {
    await clickText(page, '跳过部署引导并进入控制台')
  }
  await waitForText(page, '功能介绍', 15000)

  await ensureSidebarExpanded(page)
  await clickText(page, '主题：')
  await waitForText(page, '界面风格')
  await clickText(page, '昼白')

  await clickSidebarTab(page, '指令速查')
  await waitForText(page, '指令速查')

  await clickSidebarTab(page, 'AI模型与API配置')
  await verifyAdminIfVisible(page)
  await waitForText(page, 'AI 供应商导入')
  await waitForText(page, '模型优先级调整')
  await waitForText(page, '模型用量')
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.sidebar-nav')?.innerText || ''
    return !sidebar.includes('模型配置') && !sidebar.includes('API Keys')
  }, { timeout: 15000 })
  await clickText(page, '识图').catch(() => {})
  await clickText(page, '语音').catch(() => {})
  await waitForText(page, '语音识别')
  await clickText(page, '语音合成').catch(() => {})

  await clickSidebarTab(page, '人格实验室')
  await waitForText(page, '创建/修改人格')
  await clickText(page, '编辑').catch(() => {})
  await waitForText(page, '保存修改').catch(() => {})
  await clickText(page, '取消').catch(() => {})

  await clickSidebarTab(page, '黑白名单')
  await waitForText(page, '黑白名单管理')
  await verifyAdminIfVisible(page)
  await clickText(page, '刷新全部').catch(() => {})

  await clickSidebarTab(page, '安全设置')
  await waitForText(page, '访问密码')

  await clickSidebarTab(page, '日志中心')
  await waitForText(page, '日志中心')
  await clickButtonByLabel(page, '刷新').catch(() => {})

  await clickSidebarTab(page, '系统状态')
  await waitForText(page, '当前状态')

  await verifyResourcePanel(page, { allowWrites: false, expectMockData: false })

  await clickSidebarTab(page, '莲莲图集')
  await waitForText(page, '莲莲图集')
  await clickButtonByLabel(page, '批量删除').catch(() => {})
}

module.exports = { runLiveClicks }
