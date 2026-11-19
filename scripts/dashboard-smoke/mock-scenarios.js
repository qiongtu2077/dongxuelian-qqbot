const { BASE_URL, ROOT } = require('./runtime')
const fs = require('fs')
const path = require('path')
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
  ensureSidebarCollapsed,
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

/** Verifies that date presets, custom intervals, cancellation and all-history queries reach the UI. */
async function verifyUsageDateRanges(page) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)
  const oldDate = new Date(Date.parse(today + 'T00:00:00Z') - 60 * 86400000).toISOString().slice(0, 10)
  await page.click('.range-trigger')
  await Promise.all([
    page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname.endsWith('/keys/usage') && url.searchParams.get('startDate') === yesterday && url.searchParams.get('endDate') === yesterday
    }, { timeout: 8000 }),
    clickText(page, '昨天', '.range-popover button'),
  ])
  await waitForText(page, '所选日期区间内没有该能力的用量记录。')
  await page.click('.range-trigger')
  await clickText(page, '近 7 天', '.range-popover button')
  await page.waitForFunction(() => document.querySelector('.usage-metrics')?.innerText.includes('18,400'), { timeout: 8000 })
  await page.click('.range-trigger')
  await page.$eval('input[aria-label="用量开始日期"]', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }, today)
  await page.$eval('input[aria-label="用量结束日期"]', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }, yesterday)
  await clickText(page, '确定', '.range-popover button')
  await waitForText(page, '开始日期不能晚于结束日期')
  await clickText(page, '取消', '.range-popover button')
  await page.waitForFunction(() => document.querySelector('.range-trigger')?.textContent.includes('近 7 天'), { timeout: 8000 })
  await page.click('.range-trigger')
  for (const label of ['用量开始日期', '用量结束日期']) {
    await page.$eval(`input[aria-label="${label}"]`, (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }, oldDate)
  }
  await clickText(page, '确定', '.range-popover button')
  await page.waitForFunction(value => document.querySelector('.range-caption')?.textContent.includes(value) && document.querySelector('.usage-metrics')?.innerText.includes('18,400'), { timeout: 8000 }, oldDate)
  await clickText(page, '识图', '.usage-panel .ability-tabs button')
  await waitForText(page, '所选日期区间内没有该能力的用量记录。')
  await page.waitForFunction(value => document.querySelector('.range-trigger')?.textContent.includes(value.replaceAll('-', '/')), { timeout: 8000 }, oldDate)
  await clickText(page, '文字', '.usage-panel .ability-tabs button')
  await page.waitForFunction(() => document.querySelector('.usage-metrics')?.innerText.includes('18,400'), { timeout: 8000 })
  await page.click('.range-trigger')
  await clickText(page, '全部', '.range-popover button')
  await page.waitForFunction(() => document.querySelector('.usage-metrics')?.innerText.includes('36,800'), { timeout: 8000 })
  await page.waitForSelector('.trend-svg polyline')
  await page.click('.daily-usage summary')
  await page.waitForFunction(() => document.querySelectorAll('.daily-usage tbody tr').length === 2, { timeout: 8000 })
  const outDir = path.join(ROOT, 'tmp', 'workspace')
  fs.mkdirSync(outDir, { recursive: true })
  await (await page.$('.usage-panel')).screenshot({ path: path.join(outDir, 'usage-date-range-panel.png') })
  await page.click('.range-trigger')
  await (await page.$('.range-popover')).screenshot({ path: path.join(outDir, 'usage-date-range-picker.png') })
  await page.setViewport({ width: 380, height: 900, deviceScaleFactor: 1 })
  await clickText(page, '取消', '.range-popover button')
  await ensureSidebarCollapsed(page)
  await page.click('.range-trigger')
  await page.waitForFunction(() => {
    const rect = document.querySelector('.range-popover')?.getBoundingClientRect()
    return rect && rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight && document.documentElement.scrollWidth <= window.innerWidth
  }, { timeout: 8000 })
  await (await page.$('.range-popover')).screenshot({ path: path.join(outDir, 'usage-date-range-mobile.png') })
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })
  await clickText(page, '近 30 天', '.range-popover button')
  await ensureSidebarExpanded(page)
  await page.waitForFunction(() => document.querySelector('.usage-metrics')?.innerText.includes('18,400'), { timeout: 8000 })
}

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
  await clickSidebarTab(page, '功能与指令')
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
  await verifyParticipationControls(page)
}

/** 验证群卡片位置、添加、详情编辑、删除确认、失败恢复、持久化与窄屏布局。 */
async function verifyParticipationControls(page) {
  const groupSwitch = 'input[aria-label="群 10001 总开关"]'
  const privateSwitch = 'input[aria-label="全局私聊开关"]'
  const edit = 'button[aria-label="编辑群 10001"]'
  const outDir = path.join(ROOT, 'tmp', 'workspace')
  fs.mkdirSync(outDir, { recursive: true })
  await page.waitForFunction(sel => document.querySelector(sel)?.checked === false && !document.querySelector(sel)?.disabled, {}, privateSwitch)
  if (!await page.$eval('.participation-group-editor button', button => button.disabled)) throw new Error('empty group must disable add')
  if (!await page.$eval('.participation-card', card => card === card.parentElement.lastElementChild || card.nextElementSibling?.nodeType === 8)) throw new Error('group card must be last in control panel')
  await page.type('#participation-group-id', '10001')
  await clickVisibleSelector(page, '.participation-group-editor button')
  await page.waitForFunction(() => document.querySelector('input[aria-label="群 10001 名称"]')?.value === '东雪莲测试群')
  if (await page.$eval(groupSwitch, input => input.checked)) throw new Error('new group must start disabled')
  if (await page.$('.participation-group-editor input[role="switch"]')) throw new Error('add row must not contain switches')
  if (await page.$('.participation-group-row .participation-abusive-switch')) throw new Error('group row must use edit button')
  await page.click('input[aria-label="群 10001 名称"]', { clickCount: 3 })
  await page.keyboard.type('我的群备注')
  await clickVisibleSelector(page, 'button[aria-label="保存群 10001 名称"]')
  await waitForText(page, '群名已保存')
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForFunction(() => document.querySelector('input[aria-label="群 10001 名称"]')?.value === '我的群备注')
  await clickVisibleSelector(page, edit)
  await page.waitForSelector('#group-detail-abusiveEnabled')
  await page.click('input[aria-label="群 10001 详情名称"]', { clickCount: 3 })
  await page.keyboard.type('东雪莲测试群')
  await clickVisibleSelector(page, '#group-detail-enabled + .participation-track')
  await clickVisibleSelector(page, '#group-detail-abusiveEnabled + .participation-track')
  await clickVisibleSelector(page, '#group-detail-randomEnabled + .participation-track')
  await page.select('select[aria-label="群人格"]', '测试人格')
  await page.type('input[aria-label="主动回复基础概率（%）"]', '0')
  await page.type('input[aria-label="随机语音概率（%）"]', '100')
  await clickVisibleSelector(page, '.group-detail-footer > button')
  await waitForText(page, '群详情已保存')
  await (await page.$('.group-detail-dialog')).screenshot({ path: path.join(outDir, 'group-details-desktop.png') })
  await clickVisibleSelector(page, '.group-detail-head button')
  await page.waitForFunction(sel => document.querySelector(sel)?.checked === true, {}, groupSwitch)
  await clickVisibleSelector(page, '.participation-private .participation-track')
  await page.waitForFunction(sel => document.querySelector(sel)?.checked === true && !document.querySelector(sel)?.disabled, {}, privateSwitch)
  await page.type('#participation-group-id', '99900')
  await clickVisibleSelector(page, '.participation-group-editor button')
  await waitForText(page, '模拟保存失败')
  if (await page.$('input[aria-label="群 99900 总开关"]')) throw new Error('failed add must not create a row')
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForFunction(() => document.querySelector('input[aria-label="群 10001 总开关"]')?.checked === true)
  await page.waitForFunction(sel => document.querySelector(sel)?.checked === true, {}, privateSwitch)
  await clickVisibleSelector(page, edit)
  await page.waitForSelector('#group-detail-abusiveEnabled')
  if (!await page.$eval('#group-detail-abusiveEnabled', input => input.checked)) throw new Error('abusive setting must persist')
  if (await page.$eval('input[aria-label="主动回复基础概率（%）"]', input => input.value) !== '0') throw new Error('zero rate must persist')
  await page.click('input[aria-label="群 10001 详情名称"]', { clickCount: 3 })
  await page.keyboard.type('模拟失败')
  await clickVisibleSelector(page, '.group-detail-footer > button')
  await waitForText(page, '模拟详情保存失败')
  if (await page.$eval('input[aria-label="群 10001 名称"]', input => input.value) !== '东雪莲测试群') throw new Error('failed details must not change list')
  await clickVisibleSelector(page, '.group-detail-head button')
  if (await page.$eval('.participation-card', card => /已开启|已关闭/.test(card.innerText))) throw new Error('switch status text must be removed')
  await (await page.$('.participation-card')).screenshot({ path: path.join(outDir, 'participation-desktop.png') })
  await page.setViewport({ width: 380, height: 900, deviceScaleFactor: 1 })
  await ensureSidebarCollapsed(page)
  await page.$eval('.participation-card', card => card.scrollIntoView({ block: 'center' }))
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth)
  await (await page.$('.participation-card')).screenshot({ path: path.join(outDir, 'participation-mobile.png') })
  await clickVisibleSelector(page, edit)
  await page.waitForSelector('#group-detail-abusiveEnabled')
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth)
  await (await page.$('.group-detail-dialog')).screenshot({ path: path.join(outDir, 'group-details-mobile.png') })
  await clickVisibleSelector(page, '.group-detail-danger button')
  await page.waitForSelector('[role="alertdialog"]')
  await (await page.$('[role="alertdialog"]')).screenshot({ path: path.join(outDir, 'group-delete-mobile.png') })
  await clickVisibleSelector(page, '.group-delete-actions button:not(.danger-button)')
  await page.waitForFunction(() => !document.querySelector('[role="alertdialog"]'))
  if (!await page.$(groupSwitch)) throw new Error('cancel delete must keep group')
  await clickVisibleSelector(page, '.group-detail-danger button')
  await clickVisibleSelector(page, '.group-delete-actions .danger-button')
  await page.waitForFunction(sel => !document.querySelector(sel), {}, groupSwitch)
  if (!await page.$eval(privateSwitch, input => input.checked)) throw new Error('delete group must not alter private switch')
  await page.type('#participation-group-id', '10001')
  await clickVisibleSelector(page, '.participation-group-editor button')
  await page.waitForFunction(sel => document.querySelector(sel)?.disabled === false, {}, groupSwitch)
  // 恢复测试目录名称，后续白名单和资源页继续验证同一份本地群目录。
  await page.click('input[aria-label="群 10001 名称"]', { clickCount: 3 })
  await page.keyboard.type('东雪莲测试群')
  await clickVisibleSelector(page, 'button[aria-label="保存群 10001 名称"]')
  await waitForText(page, '群名已保存')
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })
  await ensureSidebarExpanded(page)
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
  await waitForTextInSelector(page, '.resource-task-card', '生成群聊日报')
  await waitForTextInSelector(page, '.resource-events', '媒体处理任务已完成')
  await waitForTextInSelector(page, '.resource-events', '10-05 20:22:56')
  await waitForText(page, '10001 · 东雪莲测试群')
  await waitForText(page, '20002 · 另一个测试群')
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
  await clickVisibleSelector(page, '.diagnostic-toggle')
  await waitForText(page, 'mock saved diagnostic error')
  const diagnosticTextSelectable = await page.evaluate(() => {
    const summary = document.querySelector('.diagnostic-summary')
    const error = document.querySelector('.diagnostic-error')
    const selection = window.getSelection()
    if (!summary || !error || !selection || summary.closest('button') || getComputedStyle(error).userSelect !== 'text') return false
    // 选中实际报错文字，验证诊断卡片允许用户复制，同时不触发展开按钮。
    const range = document.createRange()
    range.selectNodeContents(error)
    selection.removeAllRanges()
    selection.addRange(range)
    const selected = selection.toString().includes('mock saved diagnostic error')
    selection.removeAllRanges()
    return selected
  })
  if (!diagnosticTextSelectable) throw new Error('diagnostic text is not selectable outside the toggle button')

  await page.select('.memory-range-select', '30m')
  await waitForText(page, '平均 1038 MB')
  await waitForText(page, '最小 938 MB')
  await waitForText(page, '最大 1138 MB')
  await typePlaceholder(page, '搜索群号或群名称', '另一个测试群')
  await waitForTextInSelector(page, '.resource-precompute-card', '20002 · 另一个测试群')
  await waitForTextNotInSelector(page, '.resource-precompute-card', '10001 · 东雪莲测试群')
  await typePlaceholder(page, '搜索群号或群名称', 'no-such-group')
  await waitForText(page, '未找到匹配群号')
  await page.click('input[placeholder="搜索群号或群名称"]', { clickCount: 3 })
  await page.keyboard.press('Backspace')
  await waitForTextInSelector(page, '.resource-precompute-card', '10001 · 东雪莲测试群')
  if (!allowWrites) return

  await injectResourceScenario(page, 'idle')
  page.once('dialog', dialog => dialog.accept())
  await clickText(page, '小内存策略')
  await waitForText(page, '资源保护策略已切换为小内存策略')
  page.once('dialog', dialog => dialog.accept())
  await clickText(page, '大内存策略')
  await waitForText(page, '资源保护策略已切换为大内存策略')
  await clickText(page, '刷新记录')
  await waitForTextInSelector(page, '.resource-task-card', '等待可用内存恢复')
  await clickButtonInCard(page, '任务记录', '已完成')
  await waitForTextInSelector(page, '.resource-task-row', '下载 B 站视频 · BV1xx411c7mD')
  await waitForTextInSelector(page, '.resource-task-row', '10-05 19:44:36')
  await waitForTextNotInSelector(page, '.resource-task-row', 'mock-task-done')
  await waitForTextNotInSelector(page, '.resource-task-row', '已发送')
  await clickButtonInCard(page, '任务记录', '查看详情')
  await waitForTextInSelector(page, '.resource-task-detail', 'mock-task-done')
  const selectedContent = await page.evaluate(() => {
    const content = document.querySelector('.resource-task-content b')
    const range = document.createRange()
    range.selectNodeContents(content)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return { text: selection.toString(), selectable: getComputedStyle(content).userSelect !== 'none' }
  })
  if (!selectedContent.selectable || !selectedContent.text.includes('下载 B 站视频')) throw new Error('Task content must remain selectable')
  await clickButtonInCard(page, '任务记录', '失败')
  await waitForTextInSelector(page, '.resource-task-row', '下载 B 站视频')
  await clickButtonInCard(page, '任务记录', '查看详情')
  await waitForTextInSelector(page, '.resource-task-reason p', '误判为失联')
  await clickVisibleSelector(page, '.resource-task-reason summary')
  await waitForTextInSelector(page, '.resource-task-reason pre', 'worker heartbeat stale: local-video-sender-main')
  await clickButtonInCard(page, '任务记录', '已取消')
  await waitForTextInSelector(page, '.resource-task-card', '暂无已取消记录')
  await clickButtonInCard(page, '任务记录', '进行中')
  await waitForTextInSelector(page, '.resource-task-row', '生成群聊日报')
  await clickText(page, '刷新事件')
  await waitForTextInSelector(page, '.resource-events', '资源满足要求，允许执行。')
  page.once('dialog', dialog => dialog.accept())
  await clickText(page, '进入维护模式')
  await waitForText(page, '维护模式已开启，机器人将回复维护提示')
  await clickText(page, '结束维护模式')
  await waitForText(page, '维护模式已结束，智能回复和后台任务已恢复')
  await clickButtonNearText(page, '生成群聊日报', '查看详情')
  await waitForTextInSelector(page, '.resource-task-detail', 'mock-task-1')
  await clickText(page, '取消', '.resource-task-row .resource-task-actions button')
  await waitForTextInSelector(page, '[role="alertdialog"]', '任务 ID 与已有记录重复')
  await clickVisibleSelector(page, '.resource-cancel-dialog summary')
  await waitForTextInSelector(page, '.resource-cancel-dialog pre', 'TASK_ID_CONFLICT')
  await clickText(page, '知道了', '.resource-cancel-dialog button')
  await clickText(page, '取消', '.resource-task-row .resource-task-actions button')
  await waitForText(page, '任务已取消')
  await waitForTextInSelector(page, '.resource-task-card', '生成群聊日报')
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
  await clickSidebarTab(page, '功能与指令')
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

/** 验证协议入口仅在终端控制显示，双向浏览无启停请求，并覆盖明确启动和登录。 */
async function verifyProtocolSwitch(page) {
  const switches = []
  let loginRequests = 0
  // 记录实际 HTTP 请求，防止菜单浏览重新引入协议启停副作用。
  const trackProtocolRequest = request => {
    const pathname = new URL(request.url()).pathname
    if (request.method() === 'POST' && pathname === '/dashboard/api/protocol/switch') switches.push(JSON.parse(request.postData()).provider)
    if (pathname === '/dashboard/api/protocol/sl/login') loginRequests += 1
  }
  page.on('request', trackProtocolRequest)
  try {
    for (const label of ['功能与指令', '莲莲图集']) {
      await clickSidebarTab(page, label)
      if (await page.$('.protocol-switcher')) throw new Error(`Protocol controls must be absent from ${label}`)
    }
    await clickSidebarTab(page, '终端控制')
    await page.waitForSelector('#qq-protocol', { visible: true })
    await page.select('#qq-protocol', 'sl')
    await waitForText(page, 'SnowLuma 登录')
    await waitForText(page, '当前仅查看 SnowLuma')
    if (switches.length || loginRequests) throw new Error('Browsing SnowLuma must not switch protocols or request its login API')
    await page.select('#qq-protocol', 'napcat')
    await waitForText(page, '网络协议与终端配置')
    if (switches.length) throw new Error('Returning to NapCat must not restart either protocol')
    await page.select('#qq-protocol', 'sl')
    await clickText(page, '启动 / 重启', '.protocol-switcher button')
    await waitForText(page, '阅读并确认协议')
    if (switches.join(',') !== 'sl') throw new Error('Starting SnowLuma must send exactly one explicit switch request')
    const disabled = await page.$eval('.sl-login button.btn:not(.btn-ghost)', button => button.disabled)
    if (!disabled) throw new Error('Agreement must be explicitly accepted before continuing')
    await page.click('.consent-check input')
    await clickText(page, '确认并继续')
    await waitForText(page, '完成登录并连接 OneBot')
    await clickText(page, '完成登录并连接 OneBot')
    await waitForText(page, '机器人 OneBot 连接已恢复')
    await page.screenshot({ path: path.join(ROOT, 'tmp', 'sl-login-browser.png'), fullPage: true })
    await page.setViewport({ width: 380, height: 900, deviceScaleFactor: 1 })
    await ensureSidebarCollapsed(page)
    await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth)
    await page.screenshot({ path: path.join(ROOT, 'tmp', 'sl-login-mobile.png'), fullPage: true })
    await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })
    // 等待 .app 的宽度和边距过渡结束，避免按钮坐标在点击前移动。
    await page.waitForFunction(() => document.querySelector('.app').getAnimations().length === 0)
    await page.select('#qq-protocol', 'napcat')
    await waitForText(page, '网络协议与终端配置')
    await waitForText(page, '当前仅查看 NapCat')
    if (switches.join(',') !== 'sl') throw new Error('Browsing NapCat must keep SnowLuma running')
    const restartDisabled = await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '重启 NapCat').disabled)
    if (!restartDisabled) throw new Error('Inactive NapCat must not expose a restart action')
    await clickText(page, '启动 / 重启', '.protocol-switcher button')
    await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '重启 NapCat')?.disabled === false)
    if (switches.join(',') !== 'sl,napcat') throw new Error('Starting NapCat must send exactly one explicit switch request')
    await page.waitForFunction(() => document.querySelector('#qq-protocol').value === 'napcat')
    await clickSidebarTab(page, '莲莲图集')
    if (await page.$('.protocol-switcher')) throw new Error('Leaving terminal control must remove protocol controls and their status message')
    await clickSidebarTab(page, '终端控制')
    await page.waitForSelector('#qq-protocol', { visible: true })
    if (switches.join(',') !== 'sl,napcat') throw new Error('Navigating between panels must not restart either protocol')
  } finally { page.off('request', trackProtocolRequest) }
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
  if (process.env.DASHBOARD_SMOKE_PROTOCOL_ONLY === '1') {
    await verifyProtocolSwitch(page)
    return
  }
  if (process.env.DASHBOARD_SMOKE_PARTICIPATION_ONLY === '1') {
    await verifyControlPanel(page)
    return
  }
  await verifyLegacyAgentTabColdStart(page)

  await verifyDeployPanel(page)

  await clickText(page, '主题：')
  await waitForText(page, '界面风格')
  await clickText(page, '昼白')
  await waitForText(page, '功能介绍')

  await verifyControlPanel(page)
  await verifyProtocolSwitch(page)

  await clickSidebarTab(page, '功能与指令')
  await waitForText(page, '/help')

  await clickSidebarTab(page, 'AI模型与API配置')
  await waitForText(page, '四项能力独立保存、独立调用、独立统计')
  await waitForText(page, '已导入的 API Key')
  await waitForText(page, '模型优先级调整')
  await waitForText(page, '模型用量')
  await waitForText(page, 'GPT-4o mini')
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.sidebar-nav')?.innerText || ''
    return !sidebar.includes('模型配置') && !sidebar.includes('API Keys')
  }, { timeout: 8000 })
  await page.waitForFunction(() => (document.querySelector('.usage-metrics')?.innerText || '').includes('18,400'), { timeout: 8000 })
  await verifyUsageDateRanges(page)

  // 弹窗显式导入，千问仅保存 Key 和参考目录。
  await clickText(page, '导入 API Key', '.connections button')
  await page.select('dialog[open] select', 'openai')
  await page.type('dialog[open] input[type="password"]', 'sk-smoke-discovery')
  await clickText(page, '导入并自动检测', 'dialog[open] button')
  await waitForText(page, 'Key 与模型已导入')
  await clickText(page, '保存优先级')
  await waitForText(page, '模型优先级已保存')
  await clickText(page, '导入 API Key', '.connections button')
  await page.select('dialog[open] select', 'dashscope')
  await page.type('dialog[open] input[type="password"]', 'sk-smoke-qwen')
  await clickText(page, '导入并自动检测', 'dialog[open] button')
  await waitForText(page, 'Key 与模型已导入')
  await page.select('select[aria-label="选择要加入优先级的模型"]', 'dashscope\u0000qwen3.6-plus')
  await clickText(page, '加入末尾', 'button')
  await clickText(page, '保存优先级', 'button')
  await page.reload({ waitUntil: 'networkidle0' })
  await waitForText(page, 'qwen3.6-plus')

  await clickText(page, '识图', '.usage-panel .ability-tabs button')
  await page.waitForFunction(() => (document.querySelector('.usage-metrics')?.innerText || '').includes('7,200'), { timeout: 8000 })
  await clickText(page, '语音识别', '.usage-panel .ability-tabs button')
  await waitForText(page, '无法读取模型 Token 用量')
  await clickText(page, '语音合成', '.usage-panel .ability-tabs button')
  await waitForText(page, '所选日期区间内没有该能力的用量记录。')
  await page.setViewport({ width: 700, height: 900, deviceScaleFactor: 1 })
  await page.waitForFunction(() => {
    const panel = document.querySelector('.ai-model-api')
    return panel && panel.scrollWidth <= panel.clientWidth + 1
  }, { timeout: 8000 })
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })

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

  await clickSidebarTab(page, '终端控制')
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
