const fs = require('fs')
const path = require('path')
const puppeteer = require('puppeteer-core')

const {
  ROOT,
  LIVE_URL,
  findBrowserExecutable,
  startVite,
  waitForServer,
} = require('./dashboard-smoke/runtime')
const { installApiMock } = require('./dashboard-smoke/browser-helpers')
const { runClicks } = require('./dashboard-smoke/mock-scenarios')
const { runLiveClicks } = require('./dashboard-smoke/live-scenarios')

/** Coordinates browser startup, scenario execution, diagnostics, and cleanup. */
async function main() {
  const browserPath = findBrowserExecutable()
  if (!browserPath) {
    throw new Error('No Chrome/Edge executable found. Set PUPPETEER_EXECUTABLE_PATH to run dashboard click smoke.')
  }

  const vite = LIVE_URL ? null : startVite()
  let browser = null
  const consoleErrors = []
  const responseErrors = []
  try {
    if (vite) await waitForServer(vite)
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    page.on('response', response => {
      const status = response.status()
      if (status < 400) return
      const url = response.url()
      const pathname = new URL(url).pathname
      if (!LIVE_URL && status === 403 && pathname.startsWith('/dashboard/api/')) return
      if (!LIVE_URL && status === 404 && pathname.endsWith('/favicon.ico')) return
      responseErrors.push(`${status} ${url}`)
    })
    page.on('console', msg => {
      const text = msg.text()
      if (/Failed to load resource: the server responded with a status of (403|404)/.test(text)) return
      if (/WebSocket connection to .* failed: Page entered Back-Forward Cache\./.test(text)) return
      if (msg.type() === 'error') consoleErrors.push(text)
    })
    page.on('pageerror', error => consoleErrors.push(error.message))
    await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })
    if (LIVE_URL) {
      await runLiveClicks(page)
    } else {
      await installApiMock(page)
      await runClicks(page)
    }
    if (responseErrors.length) throw new Error('Browser response errors:\n' + responseErrors.join('\n'))
    if (consoleErrors.length) throw new Error('Browser console errors:\n' + consoleErrors.join('\n'))
    console.log(LIVE_URL ? 'dashboard live click smoke passed' : 'dashboard click smoke passed')
  } catch (error) {
    if (browser) {
      const pages = await browser.pages()
      const page = pages[pages.length - 1]
      if (page) {
        const out = path.join(ROOT, 'tmp', 'dashboard-click-smoke-failure.png')
        fs.mkdirSync(path.dirname(out), { recursive: true })
        await page.screenshot({ path: out, fullPage: true }).catch(() => {})
        console.error(`failure screenshot: ${out}`)
      }
    }
    throw error
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (vite) vite.kill()
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
