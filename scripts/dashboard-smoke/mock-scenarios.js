const { BASE_URL } = require('./runtime')
const { todayShanghaiDate, addDays, chartDate } = require('./mock-api')
const {
  waitForText,
  waitForTextInSelector,
  waitForTextNotInSelector,
  waitForFieldValue,
  waitForInputValue,
  waitForVisibleSelector,
  clickText,
  clickVisibleSelector,
  ensureSidebarExpanded,
  clickSidebarTab,
  clickSidebarTabExpectNavigation,
  clickButtonInCard,
  clickButtonNearText,
  clickButtonByLabel,
  verifyAdminIfVisible,
  typePlaceholder,
  selectOptionValue,
  waitForSelectBoxOption,
  waitForSelectBoxLabel,
  verifyAdminModalCancel,
} = require('./browser-helpers')

/** Exercises the deployment panel smoke-test flow. */
async function verifyDeployPanel(page) {
  await clickSidebarTab(page, '部署')
  await waitForText(page, '部署方式')
  await waitForText(page, 'Windows 本地部署向导')
  await waitForText(page, '当前不是 Windows 本地部署器')
  await waitForText(page, 'mock backend is not Windows')
  await waitForText(page, '/opt/mock-koishi')
  await clickText(page, '切换到远程 Linux 部署')
  await waitForText(page, '远程 Linux 部署')
  await waitForInputValue(page, 'mock-user@mock-host.invalid')
  await waitForInputValue(page, '/opt/mock-koishi')
  await waitForText(page, '发布已确认预览')
  await waitForText(page, '重建前端')
  await clickText(page, '自动填入服务器地址')
  await waitForText(page, '已读取部署配置')
  await clickText(page, '生成部署预览')
  await waitForText(page, '预览已冻结')
  await waitForText(page, 'new-release')
  await clickSidebarTab(page, '功能地图')
  await waitForText(page, '功能介绍')
}

/** Exercises the bot control panel smoke-test flow. */
async function verifyControlPanel(page) {
  await clickSidebarTab(page, '终端控制')
  await waitForText(page, 'Bot 运行节点')
  await waitForText(page, 'Online - 运行中')
  await waitForText(page, 'mock-user@mock-host.invalid')
  await waitForText(page, '点击查看 NapCat token 后显示')
  await clickText(page, '查看 NapCat token')
  await verifyAdminModalCancel(page)
  await typePlaceholder(page, '输入新的监听 QQ 号', '654321')
  // 更换 QQ 号会先进行浏览器确认，再进入管理员二次验证。
  page.once('dialog', dialog => dialog.accept())
  await clickText(page, '更换 QQ 号并重启机器人')
  await verifyAdminModalCancel(page)
  await clickText(page, '保存')
  await waitForText(page, '节流配置已保存')
}

/** Verifies that Agent Console navigation reaches its route. */
async function verifyAgentNavigation(page) {
  await clickSidebarTabExpectNavigation(page, 'Agent 控制台', '/agent/')
  await page.goBack({ waitUntil: 'networkidle0' })
  await waitForText(page, '莲莲图集')
}

/** Verifies legacy Agent tab routing from a cold start. */
async function verifyLegacyAgentTabColdStart(page) {
  await page.evaluate(() => {
    localStorage.setItem('dashboard_token', 'mock-token')
    localStorage.setItem('dashboard_deploy_unlocked', 'true')
    localStorage.setItem('dashboard_active_tab', 'agent')
    localStorage.setItem('dashboard_sidebar_expanded', 'true')
  })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForFunction(() => ['/', '/dashboard/'].includes(window.location.pathname), { timeout: 8000 })
  await waitForText(page, '功能介绍')
  await page.waitForFunction(() => {
    const text = document.body?.innerText || ''
    return !text.includes('危险工具策略') && !text.includes('QQ 继承聊天人格') && !text.includes('Mock Session')
  }, { timeout: 8000 })
  const storedTab = await page.evaluate(() => localStorage.getItem('dashboard_active_tab'))
  if (storedTab !== 'features') throw new Error(`legacy agent tab was not normalized: ${storedTab}`)
}

/** Switches the mock backend to one resource scenario and refreshes only through the real UI action. */
async function injectResourceScenario(page, scenario) {
  await page.evaluate(async value => {
    const response = await fetch('/dashboard/api/resource/mock-scenario', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: value }),
    })
    if (!response.ok) throw new Error(`resource scenario failed: ${response.status}`)
  }, scenario)
  await clickText(page, '立即刷新')
}

/** Exercises readable resource states, diagnostics pagination, and protected controls. */
async function verifyResourcePanel(page, options = {}) {
  const allowWrites = options.allowWrites !== false
  const expectMockData = options.expectMockData !== false
  await clickSidebarTab(page, '资源中心')
  await waitForText(page, '资源总览')
  await waitForText(page, '日报预计算')
  await waitForText(page, '内存走势')
  if (!expectMockData) return

  await waitForText(page, '服务状态')
  await waitForText(page, '正常')
  await waitForText(page, '资源余量')
  await waitForText(page, '注意')
  await waitForText(page, '智能助手后台处理器')
  await waitForText(page, '正常待命')
  await waitForText(page, '媒体处理队列：当前空闲')
  await waitForText(page, '当前没有等待的媒体分析任务')
  await waitForText(page, '统一采样 10s')
  await waitForText(page, '当前聚合 10s')
  await waitForText(page, '平均 1048 MB')
  await waitForText(page, '最小 948 MB')
  await waitForText(page, '最大 1148 MB')
  await waitForText(page, 'mock-task-1')
  await waitForText(page, 'mock_event')
  await waitForText(page, 'group_10001')
  await waitForText(page, 'group_20002')
  await page.waitForFunction(() => {
    const line = document.querySelector('.memory-chart-line')
    const points = line ? line.getAttribute('points') || '' : ''
    return points.length > 0 && !(document.body.innerText || '').includes('暂无内存采样')
  }, { timeout: 8000 })

  const scenarios = [
    ['working', '正在处理 1 项任务'],
    ['stopped_idle', '已停止'],
    ['stopped_backlog', '处理器已停止，仍有 3 项任务等待处理'],
    ['task_timeout', '任务运行超时'],
    ['small_browser_active', '已暂停，将自动恢复'],
    ['media_near_limit', '媒体处理队列：接近上限'],
    ['media_at_limit', '媒体处理队列：已达上限'],
    ['unknown_queue', '未知类型不会归到任一处理器'],
    ['exclusive_anomaly', '正在忙碌'],
  ]
  for (const [scenario, expected] of scenarios) {
    await injectResourceScenario(page, scenario)
    await waitForTextInSelector(page, '.resource-grid', expected)
    if (scenario === 'media_near_limit') await waitForTextInSelector(page, '.resource-media-card', '图片队列接近上限')
    if (scenario === 'media_at_limit') await waitForTextInSelector(page, '.resource-media-card', '文件队列已达上限')
    if (scenario === 'unknown_queue') {
      await page.waitForFunction(() => {
        const kpis = [...document.querySelectorAll('.resource-kpi')]
        const queue = kpis.find(item => (item.innerText || '').includes('全部排队任务'))
        const worker = document.querySelector('.resource-worker-card')?.innerText || ''
        return queue?.querySelector('strong')?.innerText === '1' && worker.includes('暂无待处理任务')
      }, { timeout: 8000 })
    }
  }
  await page.waitForFunction(() => {
    const text = document.querySelector('.resource-grid')?.innerText || ''
    return !['tool_active', 'render_active', 'background_allowed', 'backlog', 'loop ', 'stale'].some(token => text.includes(token))
  }, { timeout: 8000 })
  const hasReclaimButton = await page.evaluate(() => [...document.querySelectorAll('button')].some(button => (button.innerText || '').includes('回收 stale')))
  if (hasReclaimButton) throw new Error('resource panel still exposes the removed reclaim button')

  await clickText(page, '打开诊断记录')
  await page.waitForFunction(() => document.querySelectorAll('.diagnostic-item').length === 120, { timeout: 8000 })
  await waitForText(page, '已加载 120 / 125 条')
  await clickText(page, '加载更多')
  await page.waitForFunction(() => document.querySelectorAll('.diagnostic-item').length === 125, { timeout: 8000 })
  await waitForText(page, '因队列超限舍弃')
  await waitForText(page, '处理失败')
  await waitForText(page, '服务重启时中断')
  await waitForText(page, '历史原因未知')
  await clickVisibleSelector(page, '.diagnostic-summary')
  await waitForText(page, 'mock saved diagnostic error')

  await page.select('.memory-range-select', '30m')
  await waitForText(page, '平均 1038 MB')
  await waitForText(page, '最小 938 MB')
  await waitForText(page, '最大 1138 MB')
  await typePlaceholder(page, '搜索群号', '20002')
  await waitForTextInSelector(page, '.resource-precompute-card', 'group_20002')
  await waitForTextNotInSelector(page, '.resource-precompute-card', 'group_10001')
  await typePlaceholder(page, '搜索群号', 'no-such-group')
  await waitForText(page, '未找到匹配群号')
  await page.click('input[placeholder="搜索群号"]', { clickCount: 3 })
  await page.keyboard.press('Backspace')
  await waitForTextInSelector(page, '.resource-precompute-card', 'group_10001')
  if (!allowWrites) return

  await injectResourceScenario(page, 'idle')
  page.once('dialog', dialog => dialog.accept())
  await clickText(page, '小内存策略')
  await waitForText(page, '资源保护策略已切换为小内存策略')
  page.once('dialog', dialog => dialog.accept())
  await clickText(page, '大内存策略')
  await waitForText(page, '资源保护策略已切换为大内存策略')
  await clickText(page, '刷新队列')
  await waitForText(page, 'mock-task-2')
  await clickText(page, '刷新事件')
  await waitForText(page, 'worker event')
  page.once('dialog', dialog => dialog.accept())
  await clickText(page, '进入维护模式')
  await waitForText(page, '维护模式已开启，机器人将回复维护提示')
  await clickText(page, '结束维护模式')
  await waitForText(page, '维护模式已结束，智能回复和后台任务已恢复')
  await clickButtonNearText(page, 'mock-task-1', '取消')
  await waitForText(page, 'mock-task-1')
}

/** Verifies the responsive sidebar behavior on a mobile viewport. */
async function verifyMobileSidebar(page) {
  await page.setViewport({ width: 390, height: 820, deviceScaleFactor: 1, isMobile: true })
  await page.evaluate(() => {
    localStorage.setItem('dashboard_sidebar_expanded', 'false')
    localStorage.setItem('dashboard_active_tab', 'features')
  })
  await page.reload({ waitUntil: 'networkidle0' })
  await waitForText(page, '功能介绍')
  await ensureSidebarExpanded(page)
  await waitForVisibleSelector(page, '.sidebar-scrim')
  await clickSidebarTab(page, '指令速查')
  await waitForText(page, '/help')
  await page.waitForFunction(() => !document.querySelector('.sidebar-nav .sidebar-item'), { timeout: 8000 })
  await ensureSidebarExpanded(page)
  await waitForVisibleSelector(page, '.sidebar-scrim')
  await clickVisibleSelector(page, '.sidebar-scrim')
  await page.waitForFunction(() => !document.querySelector('.sidebar-nav .sidebar-item'), { timeout: 8000 })
  await page.waitForFunction(() => {
    const app = document.querySelector('.app')
    const head = document.querySelector('.app-head')
    if (!app || !head) return false
    const appBox = app.getBoundingClientRect()
    const headBox = head.getBoundingClientRect()
    return appBox.width > 0 && appBox.height > 0 && headBox.width > 0 && headBox.height > 0
  }, { timeout: 8000 })
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })
  await page.evaluate(() => localStorage.setItem('dashboard_sidebar_expanded', 'true'))
  await page.reload({ waitUntil: 'networkidle0' })
  await waitForText(page, '指令速查')
}

/** Runs the complete mocked Dashboard click-smoke scenario. */
async function runClicks(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    localStorage.setItem('dashboard_token', 'mock-token')
    localStorage.removeItem('dashboard_deploy_unlocked')
    localStorage.removeItem('dashboard_active_tab')
    localStorage.setItem('dashboard_sidebar_expanded', 'true')
  })
  await page.reload({ waitUntil: 'networkidle0' })

  await waitForText(page, '先完成部署')
  await clickText(page, '跳过部署引导并进入控制台')
  await waitForText(page, '功能介绍')
  await verifyLegacyAgentTabColdStart(page)

  await verifyDeployPanel(page)

  await clickText(page, '主题：')
  await waitForText(page, '界面风格')
  await clickText(page, '昼白')
  await waitForText(page, '功能介绍')

  await verifyControlPanel(page)

  await clickSidebarTab(page, '指令速查')
  await waitForText(page, '/help')

  await clickSidebarTab(page, '模型配置')
  await waitForText(page, '供应商和模型')
  await selectOptionValue(page, 'dashscope')
  await clickText(page, '+ 添加供应商')
  await typePlaceholder(page, '标识', 'localmock')
  await typePlaceholder(page, '名称', 'Local Mock')
  await clickText(page, '保存自定义供应商')
  await waitForText(page, '自定义供应商已保存')
  await clickText(page, '+ 添加步骤')
  await clickText(page, '保存全部备用链')
  await waitForText(page, 'Fallback 链已保存')

  await clickSidebarTab(page, '人格实验室')
  await waitForText(page, '创建/修改人格')
  await clickText(page, '编辑')
  await waitForFieldValue(page, '测试人格内容')
  await clickText(page, '取消')
  await clickText(page, '创建人格')
  await waitForText(page, '请输入名称')
  await typePlaceholder(page, '人格名称，如：新角色', '新测试人格')
  await typePlaceholder(page, '在此编写人格的提示词...', '这是一段模拟人格提示词。')
  await clickText(page, '创建人格')
  await waitForText(page, 'persona created')
  await clickButtonInCard(page, '世界观管理', '编辑')
  await waitForFieldValue(page, '世界观内容')
  await clickText(page, '取消', 'button')
  await clickButtonInCard(page, '世界观管理', '创建')
  await waitForText(page, '请输入标识')
  await selectOptionValue(page, '测试人格')
  await waitForSelectBoxOption(page, '克隆音色', true)
  await selectOptionValue(page, '普通人格')
  await waitForSelectBoxOption(page, '克隆音色', false)
  await selectOptionValue(page, '测试人格')
  await waitForSelectBoxOption(page, '克隆音色', true)
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === '温柔'), { timeout: 8000 })
  await Promise.all([
    page.waitForRequest(req => req.method() === 'POST' && req.url().includes('/agent/tts/preview'), { timeout: 8000 }),
    clickButtonInCard(page, '语音合成配置', '试听'),
  ])
  await page.waitForSelector('audio[src^="blob:"]', { timeout: 8000 })
  await page.waitForFunction((expectedFirstChartLabel) => {
    const audio = document.querySelector('audio')
    return audio &&
      audio.src.startsWith('blob:') &&
      audio.readyState >= HTMLMediaElement.HAVE_METADATA &&
      Number.isFinite(audio.duration) &&
      audio.duration > 0
  }, { timeout: 8000 })
  await waitForText(page, '已克隆音色')
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === '测试音色'), { timeout: 8000 })
  await Promise.all([
    page.waitForRequest(req => req.method() === 'PUT' && req.url().includes('/agent/persona/voice'), { timeout: 8000 }),
    clickButtonInCard(page, '已克隆音色', '启用'),
  ])
  await waitForSelectBoxLabel(page, '克隆音色')
  await waitForSelectBoxLabel(page, '测试音色')
  await waitForText(page, '使用：测试人格')

  await clickSidebarTab(page, 'API Keys')
  await waitForText(page, 'API Key 管理')
  await waitForText(page, '模型分布')
  await waitForText(page, 'Token 使用趋势')
  await waitForText(page, '今天')
  await waitForText(page, '7天')
  await waitForText(page, '30天')
  await waitForText(page, 'mimo-v2-omni')
  await waitForText(page, 'deepseek-v4-flash')
  if (process.env.DASHBOARD_SMOKE_DEBUG_TOKEN_STATS) {
    const tokenStatsDebug = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.distribution-table tbody tr')]
      const trendPoints = [...document.querySelectorAll('.trend-point')]
      const chartLabels = [...document.querySelectorAll('.chart-axis text')].map(el => el.textContent.trim())
      const rowText = rows.map(row => row.innerText).join('\n')
      const pointTitles = [...document.querySelectorAll('.trend-point title')].map(el => el.textContent.trim())
      const colors = rows.map(row => getComputedStyle(row.querySelector('.model-dot')).backgroundColor)
      return {
        rows: rows.length,
        trendPoints: trendPoints.length,
        chartLabels,
        rowText,
        pointTitles,
      unknownModelRows: rows.filter(row => row.innerText.includes('未分模型（历史数据）')).length,
        uniqueColors: Array.from(new Set(colors)),
        donutBackground: getComputedStyle(document.querySelector('.donut-wrap')).backgroundImage,
      }
    })
    console.log('[dashboard-smoke token-stats]', JSON.stringify(tokenStatsDebug, null, 2))
  }
  await page.waitForFunction((expectedFirstChartLabel) => {
    const text = document.body.innerText
    if (text.includes('[object Object]')) return false
    if (text.includes('"key"') || text.includes('"label"')) return false
    const rows = [...document.querySelectorAll('.distribution-table tbody tr')]
    const trendPoints = [...document.querySelectorAll('.trend-point')]
    const chartLabels = [...document.querySelectorAll('.chart-axis text')].map(el => el.textContent.trim())
    const rowText = rows.map(row => row.innerText).join('\n')
    const pointTitles = [...document.querySelectorAll('.trend-point title')].map(el => el.textContent.trim()).join('\n')
    const unknownModelRows = rows.filter(row => row.innerText.includes('未分模型（历史数据）'))
    const colors = rows.map(row => getComputedStyle(row.querySelector('.model-dot')).backgroundColor)
    const uniqueColors = new Set(colors)
    const cacheHitPoints = [...document.querySelectorAll('.trend-point title')].filter(el => el.textContent.includes('Cache Hit Rate'))
    return rows.length >= 10
      && trendPoints.length >= 10
      && rowText.includes('604.0M')
      && rowText.includes('未分模型（历史数据）')
      && unknownModelRows.length === 1
      && rowText.includes('mock-extra-model-10')
      && pointTitles.includes('196.0M')
      && cacheHitPoints.length === 0
      && uniqueColors.size >= Math.min(8, colors.length)
      && chartLabels.includes(expectedFirstChartLabel)
      && getComputedStyle(document.querySelector('.donut-wrap')).backgroundImage.includes('conic-gradient')
  }, { timeout: 8000 }, chartDate(addDays(todayShanghaiDate(), -3)))
  await clickText(page, '今天')
  await page.waitForFunction(() => {
    const text = document.body.innerText || ''
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date())
      .reduce((acc, item) => { acc[item.type] = item.value; return acc }, {})
    const todayText = `${today.year}-${today.month}-${today.day}`
    return text.includes(`今天 ${todayText}`)
      && text.includes('75.2M')
      && text.includes('mock-extra-model-10')
      && document.querySelectorAll('.distribution-table tbody tr').length >= 9
      && document.querySelectorAll('.trend-point').length >= 3
      && ![...document.querySelectorAll('.trend-point title')].some(el => el.textContent.includes('Cache Hit Rate'))
  }, { timeout: 8000 })
  await clickText(page, '30天')
  await page.waitForFunction(() => {
    const text = document.body.innerText || ''
    const labels = [...document.querySelectorAll('.chart-axis text')].map(el => el.textContent.trim())
    return document.querySelectorAll('.distribution-table tbody tr').length >= 3
      && labels.length >= 4
      && [...document.querySelectorAll('.distribution-table tbody tr')].filter(row => row.innerText.includes('未分模型（历史数据）')).length === 1
  }, { timeout: 8000 })
  await clickText(page, '编辑')
  await typePlaceholder(page, '输入新的 ai-deepseek-key.txt', 'local-smoke-placeholder')
  await clickText(page, '保存')
  await waitForText(page, 'Key 已更新并热加载')

  await clickSidebarTab(page, '黑白名单')
  await waitForText(page, '黑白名单管理')
  await clickText(page, '刷新全部')
  await waitForText(page, '已刷新')

  await clickSidebarTab(page, '安全设置')
  await waitForText(page, '访问密码')
  await typePlaceholder(page, '新访问密码', 'abc123')
  await clickText(page, '修改访问密码')
  await waitForText(page, '密码已修改，请重新登录')
  // 修改访问密码会清除登录态；mock 烟测重新登录后再检查剩余页面。
  await page.evaluate(() => {
    localStorage.setItem('dashboard_token', 'mock-token')
    localStorage.setItem('dashboard_deploy_unlocked', 'true')
  })
  await page.reload({ waitUntil: 'networkidle0' })
  await waitForText(page, '访问密码')

  await clickSidebarTab(page, '日志中心')
  await waitForText(page, 'mock log line')

  await clickSidebarTab(page, '系统状态')
  await waitForText(page, '当前供应商')
  await waitForText(page, 'deepseek')

  await verifyResourcePanel(page)

  await clickSidebarTab(page, '莲莲图集')
  await waitForText(page, '莲莲图集')
  await clickButtonByLabel(page, '批量删除')
  await waitForText(page, '点击图片选择要删除的项目')

  await verifyAgentNavigation(page)
  await verifyMobileSidebar(page)
}

module.exports = { verifyResourcePanel, runClicks }
