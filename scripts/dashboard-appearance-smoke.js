/** 在隔离浏览器中检查两个正式构建的主题、响应式布局和来源会话。 */
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const puppeteer = require('puppeteer-core')
const { ROOT, findBrowserExecutable } = require('./dashboard-smoke/runtime')
const { apiMock, jsonResponse } = require('./dashboard-smoke/mock-api')

const output = path.join(ROOT, 'tmp', 'dashboard-appearance')
const origin = 'http://127.0.0.1:15151'
const themes = ['dark-gold', 'light', 'forest-green', 'monet-purple', 'ocean-cyan', 'graphite-blue', 'clear-water', 'crimson-red', 'sakura-pink']
const menu = ['部署', '终端控制', 'AI模型与API配置', '人格实验室', '功能与指令', '黑白名单', '安全设置', 'Agent 控制台', '资源中心', '日志中心', '莲莲图集']
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png' }
const builds = { dashboard: path.join(ROOT, 'packages/koishi-plugin-dashboard/frontend/dist'), agent: path.join(ROOT, 'packages/agent-console/dist') }

// --- 本机构建与接口夹具 ---

/** 仅向此浏览器提供编译产物和模拟数据，不连接外部服务。 */
async function fixture(page, state) {
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return request.continue()
    if (url.origin !== origin) return request.abort()
    if (url.pathname === '/fixture') return request.respond({status:200, contentType:'text/html', body:'<!doctype html><title>Fixture</title>'})
    const headers = request.headers()
    const source = state.trusted && !headers['x-dashboard-password-only']
    if (url.pathname.startsWith('/dashboard/api/')) {
      const route = url.pathname.slice('/dashboard/api'.length)
      if (route === '/auth/session') return request.respond(jsonResponse({ok:true, access:source, admin:source, mode:source ? 'source' : 'anonymous'}))
      if (!source) return request.respond(jsonResponse({ok:false, code:'AUTH_REQUIRED'}, 401))
      return request.respond(apiMock(request.method(), route, { searchParams:url.searchParams, body:null, access:true, admin:true }))
    }
    const [, site, ...parts] = url.pathname.split('/')
    if (!Object.hasOwn(builds, site)) return request.respond({status:404, body:''})
    const file = path.resolve(builds[site], parts.join('/') || 'index.html')
    if (!file.startsWith(builds[site] + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return request.respond({status:404, body:''})
    if (file.endsWith('.webp')) state.images.push([path.basename(file), fs.statSync(file).size])
    return request.respond({status:200, contentType:types[path.extname(file)], body:fs.readFileSync(file)})
  })
}

/** 通过现有缓存重开指定栏目，直接加载真实页面。 */
async function dashboard(page, tab) {
  await page.evaluate(value => { localStorage.setItem('dashboard_active_tab', value); localStorage.setItem('dashboard_deploy_guide_skipped', 'true') }, tab)
  await page.goto(origin + '/dashboard/', {waitUntil:'load'})
  await page.waitForSelector('.dashboard-shell')
}

/** 等待布局稳定，检查文档滚动范围，并保存指定主题的画面。 */
async function measure(page, name, capture = false) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
  const size = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth])
  assert.ok(size[1] <= size[0], name + ' page width ' + size.join(' / '))
  if (capture) await page.screenshot({path:path.join(output, name + '.png')})
}

/** 计算真实元素及各层背景合成后的 WCAG 相对亮度比。 */
async function contrast(page, selector, property = 'color', threshold = 4.5) {
  const ratio = await page.$eval(selector, (element, property) => {
    const ctx = document.createElement('canvas').getContext('2d', {willReadFrequently:true})
    const lineage = []
    for (let parent = element; parent; parent = parent.parentElement) lineage.unshift(parent)
    ctx.fillStyle = 'white'; ctx.fillRect(0,0,1,1)
    for (const node of lineage) { ctx.fillStyle = getComputedStyle(node).backgroundColor; ctx.fillRect(0,0,1,1) }
    // 先读取层叠表面，再在同一像素叠加指定前景。
    const light = () => {
      const [r,g,b] = Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
      return .2126*r + .7152*g + .0722*b
    }
    const bg = light()
    ctx.fillStyle = getComputedStyle(element)[property]; ctx.fillRect(0,0,1,1)
    const fg = light()
    return (Math.max(bg,fg)+.05) / (Math.min(bg,fg)+.05)
  }, property)
  assert.ok(ratio >= threshold, selector + ' ' + property + ' contrast ' + ratio.toFixed(2))
  return Number(ratio.toFixed(2))
}

// --- 主题、断点和身份切换 ---

/** 对同一组数据保存各主题的登录、模型、资源、弹窗及聊天截图。 */
async function captureTheme(page, state, theme) {
  state.trusted = false
  await page.evaluate(id => localStorage.setItem('dashboard_theme', id), theme)
  state.images = []
  await page.goto(origin + '/dashboard/', {waitUntil:'load'})
  await page.waitForFunction(() => document.querySelector('.login-art img')?.naturalWidth > 0)
  assert.equal(state.images.length, 1, 'cold login image count')
  assert.ok(state.images[0][1] <= 400000)
  await measure(page, theme + '-login', true)
  const ratios = { login:await contrast(page,'.gate-copy'), field:await contrast(page,'.login-page input','borderTopColor',3) }
  state.trusted = true
  await dashboard(page,'ai-model-api')
  await page.waitForSelector('.usage-metrics')
  await measure(page,theme + '-models',true)
  ratios.navigation = await contrast(page,'.sidebar-item.active')
  await page.click('.range-trigger')
  await page.waitForSelector('.calendar-grid .endpoint')
  ratios.selectedDate = await contrast(page,'.calendar-grid .endpoint')
  await page.click('.range-popover .actions button')
  await page.click('.sidebar-action[aria-haspopup="dialog"]')
  await page.waitForSelector('dialog[open] .theme-card.active')
  assert.equal(await page.evaluate(() => document.activeElement.matches('.theme-card.active')),true)
  await measure(page,theme + '-dialog',true)
  for (let i=0; i<12; i++) await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog[open]')),true)
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => document.activeElement.matches('[aria-haspopup="dialog"]')),true)
  await page.click('.sidebar-item[aria-label="资源中心"]')
  await page.waitForSelector('.resource-task-row')
  await measure(page,theme + '-resource',true)
  ratios.content = await contrast(page,'.resource-task-content b')
  await page.goto(origin + '/agent/')
  await page.waitForSelector('.composer-input-wrapper textarea')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme),theme)
  assert.equal(await page.$$eval('.nav-group',items => items.length),4)
  assert.equal(await page.$$eval('.nav-group button',items => items.length),13)
  await measure(page,theme + '-agent',true)
  ratios.chat = await contrast(page,'.topbar h1','color',3)
  assert.equal(state.images.length,1,'workspace should not download login artwork')
  return ratios
}

/** 在六个宽度走遍主菜单、键盘抽屉和 Agent 编辑框。 */
async function checkWidths(page) {
  for (const width of [320,390,768,900,1280,1440]) {
    await page.setViewport({width,height:900})
    for (const tab of ['deploy','control','ai-model-api','persona','features','whitelist','settings','resource','logs','gallery']) {
      await dashboard(page,tab)
      await measure(page,width + '-' + tab)
      if (tab === 'features') {
        if (width <= 760) await page.click('.sidebar-toggle')
        assert.deepEqual(await page.$$eval('.sidebar-nav button',items => items.map(b => b.getAttribute('aria-label'))), menu)
        if (width <= 760) { await page.keyboard.press('Escape'); await page.waitForSelector('.sidebar-toggle[aria-expanded="false"]') }
      }
      if (tab === 'resource' && width <= 390) {
        await page.waitForSelector('.resource-task-actions button')
        const rect = await page.$eval('.resource-task-actions button',b=>({left:b.getBoundingClientRect().left,right:b.getBoundingClientRect().right,height:b.offsetHeight}))
        assert.ok(rect.left>=0 && rect.right<=width && rect.height>=44, 'resource task action ' + JSON.stringify(rect))
      }
    }
    await page.goto(origin + '/agent/')
    await page.waitForSelector('.composer-input-wrapper textarea')
    await measure(page,width + '-agent')
    if (width===900) assert.ok(await page.$eval('.nav-group button', b=>parseFloat(getComputedStyle(b).fontSize))>=12)
  }
}

/** 在截图对应的中宽窗口和宽屏核对部署标题、面板及菜单收放的位置。 */
async function checkDeployAlignment(page) {
  await page.evaluate(() => localStorage.setItem('dashboard_theme', 'dark-gold'))
  for (const width of [845, 1920]) {
    await page.setViewport({ width, height: 900 })
    await dashboard(page, 'deploy')
    await page.waitForSelector('.local-wizard-card')
    const positions = []
    for (const expanded of [true, false, true]) {
      const toggle = '.sidebar-toggle[aria-expanded="' + expanded + '"]'
      if (!await page.$(toggle)) await page.click('.sidebar-toggle')
      await page.waitForSelector(toggle)
      const position = await page.evaluate(() => {
        const title = document.querySelector('.active-view-label').getBoundingClientRect()
        const panel = document.querySelector('.local-wizard-card').parentElement.getBoundingClientRect()
        const rail = document.querySelector('.dashboard-sidebar').getBoundingClientRect()
        // 使用文档实际可排版的右边界，排除滚动条保留的空间。
        const right = document.querySelector('.dashboard-shell').getBoundingClientRect().right
        return { title: title.left, left: panel.left, width: panel.width, before: panel.left - rail.right, after: right - panel.right }
      })
      assert.ok(Math.abs(position.title - position.left) <= 1, width + 'px: 标题与面板左缘应对齐')
      assert.ok(Math.abs(position.before - position.after) <= 1, width + 'px: 面板两侧可用留白应相等')
      if (width === 845 && positions.length < 2) {
        await measure(page, expanded ? 'deploy-menu-open' : 'deploy-menu-collapsed', true)
      }
      positions.push(position)
    }
    const [open, closed, reopened] = positions
    assert.ok(Math.abs(open.width - closed.width) <= 1, width + 'px: 收放菜单时面板应保持宽度')
    assert.ok(closed.left < open.left && Math.abs(reopened.left - open.left) <= 1, width + 'px: 收起左移，展开回到原位')
    console.log('部署面板 %dpx，收起后整体左移 %dpx', width, Math.round(open.left - closed.left))
  }
}

/** 核对旧缓存定位、退出与重新核验，以及桌面模式的菜单条件。 */
async function checkSession(page,state) {
  for (const [tab,anchor] of [['status','system-status'],['commands','command-directory']]) {
    await dashboard(page,tab)
    await page.waitForFunction(id => document.activeElement.id===id,{},anchor)
  }
  await page.click('button[title="退出登录"]')
  await page.waitForSelector('.login-page')
  await page.goto(origin + '/agent/')
  await page.waitForSelector('.gate a[href="/dashboard/"]')
  await page.click('.gate a')
  await page.waitForSelector('.login-page')
  await page.locator('button::-p-text(重新验证当前来源)').click()
  await page.waitForSelector('.dashboard-shell')
  state.trusted=false
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
  await page.waitForSelector('.login-page')
  await page.evaluateOnNewDocument(()=>{window.dongxuelianDeployer={}})
  await page.goto(origin + '/dashboard/')
  await page.waitForSelector('.sidebar-nav')
  assert.deepEqual(await page.$$eval('.sidebar-nav button',items=>items.map(b=>b.getAttribute('aria-label'))),menu.filter(label=>label!=='安全设置'))
}

/** 打开一次隔离浏览器，保存可复查的数值与截图。 */
async function main() {
  fs.mkdirSync(output,{recursive:true})
  const browser=await puppeteer.launch({executablePath:findBrowserExecutable(),headless:true,args:['--no-sandbox']})
  try {
    const page=await browser.newPage()
    page.setDefaultTimeout(10000)
    await page.setViewport({width:1280,height:900})
    const errors=[]
    page.on('pageerror',e=>errors.push(e.message))
    const state={trusted:false,images:[]}
    await fixture(page,state)
    await page.goto(origin+'/fixture')
    const report={}
    for (const theme of themes) report[theme]=await captureTheme(page,state,theme)
    await checkDeployAlignment(page)
    await checkWidths(page)
    await checkSession(page,state)
    assert.deepEqual(errors,[])
    fs.writeFileSync(path.join(output,'contrast.json'),JSON.stringify(report,null,2))
    console.log('Dashboard and Agent appearance passed: 9 themes, 47 screenshots, six responsive widths and two desktop menu alignment checks')
  } finally { await browser.close() }
}
main().catch(e=>{console.error(e);process.exitCode=1})
