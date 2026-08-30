const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const FRONTEND_DIR = path.join(ROOT, 'packages', 'koishi-plugin-dashboard', 'frontend')
const PORT = Number(process.env.DASHBOARD_SMOKE_PORT || 5177)
const BASE_URL = `http://127.0.0.1:${PORT}/`
const LIVE_URL = process.env.DASHBOARD_SMOKE_LIVE_URL || ''
const LIVE_PASSWORD = process.env.DASHBOARD_SMOKE_PASSWORD || ''
const LIVE_ADMIN_PASSWORD = process.env.DASHBOARD_SMOKE_ADMIN_PASSWORD || ''
const LIVE_TOKEN = process.env.DASHBOARD_SMOKE_TOKEN || ''
const LIVE_ADMIN_TOKEN = process.env.DASHBOARD_SMOKE_ADMIN_TOKEN || ''

/** Finds an installed Chrome-compatible browser executable. */
function findBrowserExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean)
  return candidates.find(item => fs.existsSync(item))
}

/** Starts the Dashboard frontend development server for the smoke test. */
function startVite() {
  const viteBin = path.join(FRONTEND_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: FRONTEND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', chunk => process.stdout.write('[vite] ' + chunk.toString()))
  child.stderr.on('data', chunk => process.stderr.write('[vite] ' + chunk.toString()))
  return child
}

/** Waits until the Dashboard development server accepts requests. */
async function waitForServer(child) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 60000) {
    if (child.exitCode !== null) throw new Error(`vite exited with code ${child.exitCode}`)
    try {
      const res = await fetch(BASE_URL)
      if (res.ok) return
    } catch { /* non-critical: server may not be ready yet */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('vite server did not become ready')
}

module.exports = {
  ROOT,
  BASE_URL,
  LIVE_URL,
  LIVE_PASSWORD,
  LIVE_ADMIN_PASSWORD,
  LIVE_TOKEN,
  LIVE_ADMIN_TOKEN,
  findBrowserExecutable,
  startVite,
  waitForServer,
}
