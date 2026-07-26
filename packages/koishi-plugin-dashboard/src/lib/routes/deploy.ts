'use strict'

import type { IncomingMessage, ServerResponse } from 'http'

const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const os = require('os') as typeof import('os')
const crypto = require('crypto') as typeof import('crypto')
const { exec, execSync } = require('child_process') as typeof import('child_process')
const { json, collectBody, log, shellQuote, isInsidePath, copyRecursiveSync } = require('../utils') as typeof import('../utils')
const { KOISHI_DIR, DATA_DIR, PLUGIN_ROOT, FE_DIR, DIST_DIR, LOCAL_DEPLOY_MANIFEST_FILE, LOCAL_NAPCAT_DIR_FILE, PORT, toProjectRel } = require('../paths') as typeof import('../paths')
const { requireAdmin } = require('../auth') as typeof import('../auth')
const { getCommandInfo, getLocalToolCommand, checkPortState } = require('../tools') as typeof import('../tools')
const { detectNapcatInstallation, resolveNapcatWebuiListenPort, resolveNapcatOnebotListenPort } = require('../napcat') as typeof import('../napcat')
const { buildFrontendDist } = require('../frontend') as typeof import('../frontend')
const { localTasks, getTaskPublicStatus, spawnLocalTask, getRebuildStatus, setRebuildStatus } = require('../deploy-state') as typeof import('../deploy-state')
const { readLastLogLines } = require('../logging') as typeof import('../logging')
const dh = require('../deploy-helpers') as typeof import('../deploy-helpers')

const DEPLOY_CONFIG_FILE = path.join(DATA_DIR, 'deploy-config.json')
const DEPLOY_TASKS_DIR = path.join(DATA_DIR, 'deploy-tasks')
const DEFAULT_REMOTE_APP_DIR = process.env.DASHBOARD_REMOTE_APP_DIR || process.env.KOISHI_REMOTE_APP_DIR || ''

interface DeployConfirmConfig {
  deployedAt?: number
  deployFingerprint?: string
  [key: string]: unknown
}

interface InstallDetail {
  message?: string
  [key: string]: unknown
}

interface DeployUploadBody extends Record<string, unknown> {
  name?: unknown
  data?: unknown
}

interface LocalDeployBody extends Record<string, unknown> {
  qq?: unknown
  provider?: unknown
  model?: unknown
  baseUrl?: unknown
  apiKey?: unknown
  adminIds?: unknown
}

interface LocalUninstallBody {
  confirm?: unknown
  deleteUserDataKeys?: unknown[]
}

interface NapcatDownloadBody {
  url?: unknown
}

interface NapcatWindowsDownloadBody {
  installDir?: unknown
}

interface NpmGuideStep {
  label: string
  command: string
}

type DeployRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL
) => void | Promise<void>

interface DeployPrefixRoute {
  prefix: string
  method: string
  handler: DeployRouteHandler
}

type PortState = ReturnType<typeof checkPortState>
type LegacyCommandInfo = ReturnType<typeof getCommandInfo> & {
  path?: string
}

function getLegacyErrorMessage(error: unknown): unknown {
  return (error as { message?: unknown } | null | undefined)?.message
}

function requireStrictAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  const { isLocalAuthBypass, validateAdminToken } = require('../auth') as typeof import('../auth')
  if (isLocalAuthBypass(req)) return true
  const token = String(req.headers['x-admin-token'] || '').trim()
  if (!token || !validateAdminToken(token)) { json(res, { ok: false, message: '需要管理员密码验证', code: 'ADMIN_REQUIRED' }, 403); return false }
  return true
}

function stopKoishiProcesses(): unknown {
  const { stopKoishiProcesses: doStop } = require('./bot') as typeof import('./bot')
  return doStop()
}

function handleGetDeployConfig(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    const cfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_FILE, 'utf8'))
    let botRunning = false
    try { execSync('ss -tlnp | grep -q :5140', { stdio: 'ignore' }); botRunning = true } catch { /* non-critical: port probe fallback */ }
    cfg._localFingerprint = dh.computeFingerprint()
    return json(res, { ...cfg, botRunning })
  } catch { return json(res, { server: '', appDir: DEFAULT_REMOTE_APP_DIR, botRunning: false, _localFingerprint: dh.computeFingerprint() }) }
}

function handleGetCheckUpdate(req: IncomingMessage, res: ServerResponse): void {
  const local = dh.computeFingerprint()
  let deployed = ''
  try { deployed = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_FILE, 'utf8')).deployFingerprint || '' } catch { /* non-critical: missing deploy config */ }
  return json(res, { local, deployed, upToDate: local === deployed })
}

function handlePutDeployConfig(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const cfg = dh.validateDeployTarget(JSON.parse(body))
      const tmp = DEPLOY_CONFIG_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
      fs.renameSync(tmp, DEPLOY_CONFIG_FILE)
      json(res, { ok: true, message: '配置已保存' })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handlePostDeployRun(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const cfg = dh.validateDeployTarget(JSON.parse(body))
      if (cfg.mode === 'install') return json(res, { ok: false, message: 'First-time install is not automated yet. Please run setup.sh or a local installer first.' }, 400)
      if (getRebuildStatus().state === 'building') return json(res, { ok: false, message: '前端正在构建中，请等待完成' }, 400)
      if (!cfg.server || !cfg.appDir) return json(res, { ok: false, message: '配置不完整' }, 400)
      const taskId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex')
      if (!fs.existsSync(DEPLOY_TASKS_DIR)) fs.mkdirSync(DEPLOY_TASKS_DIR, { recursive: true })
      const logFile = path.join(DEPLOY_TASKS_DIR, taskId + '.log')
      const taskLog = (msg: string): void => { try { fs.appendFileSync(logFile, msg + '\n', 'utf8') } catch { /* non-critical: progress log best effort */ } }
      json(res, { ok: true, taskId })
      taskLog('开始远程刷新部署：先重建当前 Dashboard 后端机器上的前端源码')
      buildFrontendDist({ log: taskLog, updateStatus: status => setRebuildStatus(status) }, (buildErr) => {
        if (buildErr) { taskLog('❌ 前端构建失败，已停止远程部署：' + buildErr.message); taskLog('FAIL'); return }
        const repoRoot = path.join(PLUGIN_ROOT, '..', '..')
        const s = cfg.server, d = cfg.appDir
        const pkgs = ['koishi-plugin-dongxuelian-ai','koishi-plugin-dongxuelian-help','koishi-plugin-group-name-at','koishi-plugin-defense','koishi-plugin-local-video-sender','koishi-plugin-group-leave-notice','koishi-plugin-dongxuelian-poke','koishi-plugin-daily-report']
        const cmds: string[] = []
        const dashboardDir = dh.remoteJoin(d, 'packages', 'koishi-plugin-dashboard')
        const dashboardFrontendDir = dh.remoteJoin(dashboardDir, 'frontend')
        const dashboardSrcDir = dh.remoteJoin(dashboardFrontendDir, 'src')
        const dashboardSrcNextDir = dh.remoteJoin(dashboardFrontendDir, 'src.next')
        const dashboardPublicDir = dh.remoteJoin(dashboardFrontendDir, 'public')
        const dashboardPublicNextDir = dh.remoteJoin(dashboardFrontendDir, 'public.next')
        const dashboardDistDir = dh.remoteJoin(dashboardFrontendDir, 'dist')
        const dashboardDistNextDir = dh.remoteJoin(dashboardFrontendDir, 'dist.next')
        const scriptsDir = dh.remoteJoin(d, 'scripts')
        const dataDir = dh.remoteJoin(d, 'data')
        const aiSkillsSeedDir = path.join(repoRoot, 'packages', 'koishi-plugin-dongxuelian-ai', 'data', 'ai-skills')
        const remoteAiSkillsSeedNextDir = dh.remoteJoin(dataDir, '.ai-skills-seed.next')
        const existingInstallCheck = `test -f ${shellQuote(dh.remoteJoin(d, 'node_modules', 'koishi', 'bin.js'))} && (test -f ${shellQuote(dh.remoteJoin(d, 'koishi.config.js'))} || test -f ${shellQuote(dh.remoteJoin(d, 'koishi.yml'))})`
        cmds.push(`echo "preflight"`)
        cmds.push(dh.sshCommand(s, existingInstallCheck))
        cmds.push(`echo "prepare dirs"`)
        cmds.push(dh.sshCommand(s, `mkdir -p ${[dataDir, dashboardDir, dashboardFrontendDir, scriptsDir].concat(pkgs.map(pkg => dh.remoteJoin(d, 'node_modules', pkg, 'lib'))).map(shellQuote).join(' ')}`))
        for (const pkg of pkgs) {
          cmds.push(`echo "→ ${pkg}"`)
          const pkgRoot = path.join(repoRoot, 'packages', pkg)
          const remotePkgRoot = dh.remoteJoin(d, 'node_modules', pkg)
          cmds.push(dh.scpCommand(path.join(pkgRoot, 'lib'), dh.scpRemoteTarget(s, remotePkgRoot), { recursive: true }))
          cmds.push(dh.scpCommand(path.join(pkgRoot, 'package.json'), dh.scpRemoteTarget(s, dh.remoteJoin(remotePkgRoot, 'package.json'))))
          const templatesDir = path.join(pkgRoot, 'templates')
          if (fs.existsSync(templatesDir)) cmds.push(dh.scpCommand(templatesDir, dh.scpRemoteTarget(s, remotePkgRoot), { recursive: true }))
        }
        cmds.push(`echo "Dashboard 后端和前端源码..."`)
        cmds.push(dh.scpCommand(path.join(PLUGIN_ROOT, 'standalone.js'), dh.scpRemoteTarget(s, dh.remoteJoin(dashboardDir, 'standalone.js'))))
        for (const name of ['index.html', 'package.json', 'vite.config.ts']) { const localFile = path.join(FE_DIR, name); if (fs.existsSync(localFile)) cmds.push(dh.scpCommand(localFile, dh.scpRemoteTarget(s, dh.remoteJoin(dashboardFrontendDir, name)))) }
        cmds.push(dh.sshCommand(s, `rm -rf ${shellQuote(dashboardSrcNextDir)}`))
        cmds.push(dh.scpCommand(path.join(FE_DIR, 'src'), dh.scpRemoteTarget(s, dashboardSrcNextDir), { recursive: true }))
        cmds.push(dh.sshCommand(s, `rm -rf ${shellQuote(dashboardSrcDir)} && mv ${shellQuote(dashboardSrcNextDir)} ${shellQuote(dashboardSrcDir)}`))
        if (fs.existsSync(path.join(FE_DIR, 'public'))) { cmds.push(dh.sshCommand(s, `rm -rf ${shellQuote(dashboardPublicNextDir)}`)); cmds.push(dh.scpCommand(path.join(FE_DIR, 'public'), dh.scpRemoteTarget(s, dashboardPublicNextDir), { recursive: true })); cmds.push(dh.sshCommand(s, `rm -rf ${shellQuote(dashboardPublicDir)} && mv ${shellQuote(dashboardPublicNextDir)} ${shellQuote(dashboardPublicDir)}`)) }
        else { cmds.push(dh.sshCommand(s, `rm -rf ${shellQuote(dashboardPublicDir)} ${shellQuote(dashboardPublicNextDir)}`)) }
        cmds.push(`echo "Dashboard 前端 dist..."`)
        if (fs.existsSync(aiSkillsSeedDir)) { cmds.push(`echo "AI skills seed..."`); cmds.push(dh.sshCommand(s, `rm -rf ${shellQuote(remoteAiSkillsSeedNextDir)}`)); cmds.push(dh.scpCommand(aiSkillsSeedDir, dh.scpRemoteTarget(s, remoteAiSkillsSeedNextDir), { recursive: true })); cmds.push(dh.sshCommand(s, `mkdir -p ${shellQuote(dh.remoteJoin(dataDir, 'ai-skills'))} && cp -rn ${shellQuote(remoteAiSkillsSeedNextDir + '/.')} ${shellQuote(dh.remoteJoin(dataDir, 'ai-skills') + '/')} 2>/dev/null || true; rm -rf ${shellQuote(remoteAiSkillsSeedNextDir)}`)) }
        cmds.push(dh.sshCommand(s, `rm -rf ${shellQuote(dashboardDistNextDir)}`))
        cmds.push(dh.scpCommand(DIST_DIR, dh.scpRemoteTarget(s, dashboardDistNextDir), { recursive: true }))
        cmds.push(dh.sshCommand(s, `test -f ${shellQuote(dh.remoteJoin(dashboardDistNextDir, 'index.html'))} && ls ${shellQuote(dh.remoteJoin(dashboardDistNextDir, 'assets'))}/*.js >/dev/null 2>&1 && rm -rf ${shellQuote(dashboardDistDir)} && mv ${shellQuote(dashboardDistNextDir)} ${shellQuote(dashboardDistDir)}`))
        cmds.push(`echo "重启脚本..."`)
        const restartScript = fs.existsSync(path.join(repoRoot, 'scripts', 'restart-bot.sh')) ? path.join(repoRoot, 'scripts', 'restart-bot.sh') : path.join(repoRoot, 'restart-bot.sh')
        cmds.push(dh.scpCommand(restartScript, dh.scpRemoteTarget(s, dh.remoteJoin(d, 'restart.sh'))))
        if (fs.existsSync(path.join(repoRoot, 'scripts', 'seal-data-dir.sh'))) cmds.push(dh.scpCommand(path.join(repoRoot, 'scripts', 'seal-data-dir.sh'), dh.scpRemoteTarget(s, dh.remoteJoin(scriptsDir, 'seal-data-dir.sh'))))
        if (fs.existsSync(path.join(repoRoot, 'scripts', 'watchdog.sh'))) cmds.push(dh.scpCommand(path.join(repoRoot, 'scripts', 'watchdog.sh'), dh.scpRemoteTarget(s, dh.remoteJoin(scriptsDir, 'watchdog.sh'))))
        const dashboardServiceInstaller = path.join(repoRoot, 'scripts', 'install-dashboard-service.sh')
        if (fs.existsSync(dashboardServiceInstaller)) cmds.push(dh.scpCommand(dashboardServiceInstaller, dh.scpRemoteTarget(s, dh.remoteJoin(scriptsDir, 'install-dashboard-service.sh'))))
        const logrotateInstaller = path.join(repoRoot, 'scripts', 'install-logrotate.sh')
        if (fs.existsSync(logrotateInstaller)) cmds.push(dh.scpCommand(logrotateInstaller, dh.scpRemoteTarget(s, dh.remoteJoin(scriptsDir, 'install-logrotate.sh'))))
        cmds.push(dh.sshCommand(s, `chmod +x ${[dh.remoteJoin(d, 'restart.sh'), dh.remoteJoin(scriptsDir, 'seal-data-dir.sh'), dh.remoteJoin(scriptsDir, 'watchdog.sh'), dh.remoteJoin(scriptsDir, 'install-dashboard-service.sh'), dh.remoteJoin(scriptsDir, 'install-logrotate.sh')].map(shellQuote).join(' ')} 2>/dev/null || true`))
        cmds.push(dh.sshCommand(s, `if [ -f ${shellQuote(dh.remoteJoin(scriptsDir, 'seal-data-dir.sh'))} ]; then KOISHI_DIR=${shellQuote(d)} DONGXUELIAN_AI_DATA_DIR=${shellQuote(dataDir)} sh ${shellQuote(dh.remoteJoin(scriptsDir, 'seal-data-dir.sh'))}; fi`))
        if (fs.existsSync(path.join(DATA_DIR, 'bilibili-cookies.txt'))) cmds.push(dh.scpCommand(path.join(DATA_DIR, 'bilibili-cookies.txt'), dh.scpRemoteTarget(s, '/root/bilibili-cookies.txt')))
        cmds.push(`echo "安装 Dashboard 开机自起服务（幂等，不重启正在跑的 Dashboard）"`)
        cmds.push(dh.sshCommand(s, `if [ -f ${shellQuote(dh.remoteJoin(scriptsDir, 'install-dashboard-service.sh'))} ]; then KOISHI_APP_DIR=${shellQuote(d)} DONGXUELIAN_AI_DATA_DIR=${shellQuote(dataDir)} DASHBOARD_PORT=5150 bash ${shellQuote(dh.remoteJoin(scriptsDir, 'install-dashboard-service.sh'))}; fi`))
        cmds.push(`echo "安装 Koishi/NapCat 日志轮转（幂等，不重启服务）"`)
        cmds.push(dh.sshCommand(s, `if [ -f ${shellQuote(dh.remoteJoin(scriptsDir, 'install-logrotate.sh'))} ]; then KOISHI_APP_DIR=${shellQuote(d)} bash ${shellQuote(dh.remoteJoin(scriptsDir, 'install-logrotate.sh'))}; fi`))
        cmds.push(`echo "重启 Bot..."`)
        cmds.push(dh.sshCommand(s, `bash ${shellQuote(dh.remoteJoin(d, 'restart.sh'))}`))
        cmds.push(dh.sshCommand(s, `if ss -tlnp | grep -q :5140 || curl -fsS http://127.0.0.1:5140 >/dev/null; then exit 0; fi; echo ${shellQuote('health check failed; last koishi.log lines:')}; tail -30 ${shellQuote(dh.remoteJoin(d, 'koishi.log'))}; exit 1`))
        cmds.push(`echo "✅ 部署完成"`)
        let idx = 0
        function runNext(): void {
          if (idx >= cmds.length) { try { dh.writeDeployFingerprint(DEPLOY_CONFIG_FILE, { server: s, appDir: d, mode: cfg.mode }) } catch (e) { taskLog('warning: deploy fingerprint write failed: ' + getLegacyErrorMessage(e)) }; taskLog('DONE'); return }
          taskLog('$ ' + cmds[idx])
          exec(cmds[idx], { cwd: repoRoot, timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => { if (stdout) taskLog(stdout.trim()); if (stderr) taskLog(stderr.trim()); if (err) { taskLog('❌ ' + err.message); taskLog('FAIL'); return }; idx++; runNext() })
        }
        runNext()
      })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handleGetDeployProgress(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (!requireAdmin(req, res)) return
  const taskId = pathname.split('/').pop()
  if (!taskId || !/^[a-z0-9]+$/.test(taskId)) return json(res, { ok: false, message: '无效 taskId' }, 400)
  try {
    const logFile = path.join(DEPLOY_TASKS_DIR, taskId + '.log')
    if (!fs.existsSync(logFile)) return json(res, { ok: false, lines: [], done: false })
    const stat = fs.statSync(logFile)
    const start = Math.max(0, stat.size - dh.MAX_DEPLOY_TASK_LOG_BYTES)
    const fd = fs.openSync(logFile, 'r')
    const buffer = Buffer.alloc(stat.size - start)
    try { fs.readSync(fd, buffer, 0, buffer.length, start) } finally { fs.closeSync(fd) }
    const raw = buffer.toString('utf8').trim()
    const lines = raw ? raw.split('\n') : []
    const lastLine = lines.length > 0 ? lines[lines.length - 1] : ''
    const done = lastLine === 'DONE' || lastLine === 'FAIL'
    return json(res, { ok: true, lines, done, success: lastLine === 'DONE' })
  } catch { return json(res, { ok: false, lines: [], done: false }) }
}

function handlePostFrontendRebuild(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  if (getRebuildStatus().state === 'building') return json(res, { ok: false, message: '正在构建中，请等待完成' })
  const started = buildFrontendDist({ log: msg => log('frontend rebuild: ' + msg), updateStatus: status => setRebuildStatus(status) }, (err) => { if (err) log('frontend rebuild failed: ' + err.message) })
  if (!started) return json(res, { ok: false, message: getRebuildStatus().detail || '前端构建启动失败' }, 500)
  return json(res, { ok: true, message: '前端构建已启动' })
}

function handleGetFrontendRebuildStatus(req: IncomingMessage, res: ServerResponse): void { return json(res, getRebuildStatus()) }

function handlePostDeployConfirm(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    let cfg: DeployConfirmConfig = {}
    try { cfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_FILE, 'utf8')) } catch { /* non-critical: missing deploy config */ }
    cfg.deployedAt = Date.now()
    cfg.deployFingerprint = dh.computeFingerprint()
    const tmp = DEPLOY_CONFIG_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
    fs.renameSync(tmp, DEPLOY_CONFIG_FILE)
    json(res, { ok: true })
  } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
}

function handlePostDeployUpload(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { name, data } = JSON.parse(body) as DeployUploadBody
      if (!name || !data) return json(res, { ok: false, message: '文件名或内容为空' }, 400)
      if (name !== 'bilibili-cookies.txt') return json(res, { ok: false, message: 'only bilibili-cookies.txt can be uploaded here' }, 400)
      const filePath = path.join(DATA_DIR, 'bilibili-cookies.txt')
      const raw = String(data || '').trim()
      const estimatedBytes = Math.floor(raw.length * 3 / 4)
      if (estimatedBytes > dh.MAX_DEPLOY_UPLOAD_BYTES) return json(res, { ok: false, message: '上传文件过大' }, 413)
      const buf = Buffer.from(raw, 'base64')
      if (buf.length > dh.MAX_DEPLOY_UPLOAD_BYTES) return json(res, { ok: false, message: '上传文件过大' }, 413)
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(filePath, buf)
      json(res, { ok: true, message: 'bilibili-cookies.txt 已保存到本地，部署时将自动推送' })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handlePostDeployLocal(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const cfg = JSON.parse(body) as LocalDeployBody
      const workDir = path.resolve(KOISHI_DIR)
      const qq = String(cfg.qq || '').trim()
      const provider = String(cfg.provider || 'opencode').trim() || 'opencode'
      const model = String(cfg.model || '').trim()
      const baseUrl = String(cfg.baseUrl || '').trim()
      if (!/^\d+$/.test(qq)) return json(res, { ok: false, message: 'QQ 号不能为空或格式错误' }, 400)
      if (!/^[A-Za-z0-9._-]+$/.test(provider)) return json(res, { ok: false, message: '供应商名称格式错误' }, 400)
      if (!model) return json(res, { ok: false, message: '模型不能为空' }, 400)
      if (baseUrl) { try { const parsed = new URL(baseUrl); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad') } catch { return json(res, { ok: false, message: 'API 地址必须是 http/https URL' }, 400) } }
      if (!isInsidePath(KOISHI_DIR, workDir)) return json(res, { ok: false, message: '本地部署目录必须在当前项目目录内' }, 400)
      dh.writeRuntimeLayout()
      const pkgs = ['koishi-plugin-dongxuelian-ai','koishi-plugin-dongxuelian-help','koishi-plugin-group-name-at','koishi-plugin-defense','koishi-plugin-local-video-sender','koishi-plugin-group-leave-notice','koishi-plugin-dongxuelian-poke','koishi-plugin-daily-report']
      const copiedPlugins: string[] = []
      for (const pkg of pkgs) {
        const src = path.join(PLUGIN_ROOT, '..', pkg)
        const dst = path.join(workDir, 'node_modules', pkg)
        if (fs.existsSync(src)) {
          copyRecursiveSync(path.join(src, 'lib'), path.join(dst, 'lib'))
          copyRecursiveSync(path.join(src, 'package.json'), path.join(dst, 'package.json'))
          const templatesDir = path.join(src, 'templates')
          if (fs.existsSync(templatesDir)) copyRecursiveSync(templatesDir, path.join(dst, 'templates'))
          copiedPlugins.push(pkg)
        }
      }
      const timestamp = Date.now()
      const files: ReturnType<typeof dh.writeTrackedLocalFile>[] = []
      files.push(dh.writeTrackedLocalFile('data/ai-provider.txt', provider + '\n', { deleteByDefault: true, kind: 'provider' }, timestamp))
      files.push(dh.writeTrackedLocalFile('data/ai-model.txt', model + '\n', { deleteByDefault: true, kind: 'model' }, timestamp))
      files.push(dh.writeTrackedLocalFile('data/ai-base-url.txt', baseUrl + '\n', { deleteByDefault: true, kind: 'baseUrl' }, timestamp))
      const inputApiKey = String(cfg.apiKey || '').trim()
      const keyFiles: Record<string, string> = { opencode: 'ai-openai-key.txt', deepseek: 'ai-deepseek-key.txt', dashscope: 'ai-dashscope-key.txt', glm: 'ai-glm-key.txt', mimorium: 'ai-mimorium-key.txt' }
      const keyFile = keyFiles[provider] || keyFiles.opencode
      if (inputApiKey) files.push(dh.writeTrackedLocalFile('data/' + keyFile, inputApiKey + '\n', { deleteByDefault: false, sensitive: true, kind: 'apiKey' }, timestamp))
      if (cfg.adminIds) files.push(dh.writeTrackedLocalFile('data/ai-admin-ids.json', JSON.stringify(cfg.adminIds, null, 2) + '\n', { deleteByDefault: false, sensitive: true, kind: 'adminIds' }, timestamp))
      const yml = `port: 5140\nselfUrl: http://localhost:5140\nplugins:\n  adapter-onebot:\n    protocol: ws\n    selfId: '${qq}'\n    endpoint: ws://127.0.0.1:8080/onebot/v11/ws\n  defense: {}\n  dongxuelian-ai: {}\n  dongxuelian-help: {}\n  group-name-at: {}\n  local-video-sender: {}\n  group-leave-notice: {}\n  dongxuelian-poke: {}\n  daily-report: {}\n`
      files.push(dh.writeTrackedLocalFile('koishi.yml', yml, { deleteByDefault: true, kind: 'koishiConfig' }, timestamp))
      const helper = `@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nif exist "%~dp0runtime\\node\\node.exe" set "PATH=%~dp0runtime\\node;%PATH%"\r\nset "KOISHI_DIR=%~dp0"\r\nset "DONGXUELIAN_AI_DATA_DIR=%~dp0data"\r\nif not exist node_modules\\koishi (\r\n  echo [ERROR] Dependencies missing or incomplete. Please run "npm install" first.\r\n  echo Project directory: %~dp0\r\n  pause\r\n  exit /b 1\r\n)\r\nnode start.js\r\n`
      files.push(dh.writeTrackedLocalFile('start-local.bat', helper, { deleteByDefault: true, kind: 'startScript' }, timestamp))
      const aiKey = dh.getAiKeyStatus(provider)
      const manifest = { version: 1, generatedAt: timestamp, qq, onebotEndpoint: 'ws://127.0.0.1:8080/onebot/v11/ws', aiKeyConfigured: aiKey.configured, files }
      dh.writeLocalDeployManifest(manifest)
      json(res, { ok: true, message: aiKey.configured ? 'Koishi 本地配置已写入，NapCat 使用 8080 OneBot WebSocket' : 'Koishi 本地配置已写入；AI Key 未配置，基础部署可继续，AI 回复暂不可用', files, copiedPlugins, aiKeyConfigured: aiKey.configured, aiKey, manifest: { path: toProjectRel(LOCAL_DEPLOY_MANIFEST_FILE), generatedAt: timestamp } })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handleGetLocalConfigPreview(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  try { return json(res, dh.buildLocalConfigPreview()) } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
}

function handlePostLocalConfigDelete(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  collectBody(req, res, () => {
    try { const result = dh.deleteLocalConfigFiles(); return json(res, { ...result, message: result.errors.length ? '部分配置未能删除' : 'Koishi 本地配置已删除' }, result.errors.length ? 400 : 200) }
    catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handleGetLocalUninstallPreview(req: IncomingMessage, res: ServerResponse): void {
  if (!requireStrictAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  try {
    const { buildLocalUninstallPreview } = require('../deploy-uninstall') as typeof import('../deploy-uninstall')
    const preview = buildLocalUninstallPreview()
    return json(res, { ...preview })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
}

function handlePostLocalUninstall(req: IncomingMessage, res: ServerResponse): void {
  if (!requireStrictAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const cfg = JSON.parse(body || '{}') as LocalUninstallBody
      if (!cfg.confirm) return json(res, { ok: false, message: '缺少一键卸载确认标记' }, 400)
      const { runLocalUninstall } = require('../deploy-uninstall') as typeof import('../deploy-uninstall')
      const result = runLocalUninstall(cfg)
      return json(res, { ...result })
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handlePostNapcatDownload(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { url } = JSON.parse(body) as NapcatDownloadBody
      if (!url) return json(res, { ok: false, message: '下载地址不能为空' }, 400)
      dh.downloadToRuntime(String(url), { preferredName: 'napcat-manual.zip', expectedExt: '.zip', minBytes: 128 * 1024 }, (err, filePath, download) => {
        if (err) return json(res, { ok: false, message: err.message }, 400)
        json(res, { ok: true, message: 'NapCat 包已下载到 ' + filePath, path: filePath, download })
      })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handlePostNapcatWindowsDownload(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { installDir } = JSON.parse(body || '{}') as NapcatWindowsDownloadBody
      const targetDir = dh.validateNapcatInstallDir(installDir)
      dh.downloadNapcatWindowsRelease(targetDir, (err, detail: InstallDetail = {}) => {
        if (err) return json(res, { ok: false, message: err.message, ...detail }, 400)
        fs.mkdirSync(path.dirname(LOCAL_NAPCAT_DIR_FILE), { recursive: true })
        fs.writeFileSync(LOCAL_NAPCAT_DIR_FILE, targetDir, 'utf8')
        json(res, { ok: true, message: detail.message || 'NapCat（Windows）OneKey 包已下载并解压', ...detail, napcat: detectNapcatInstallation() })
      })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handlePostNodeWindowsInstall(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  collectBody(req, res, () => {
    try {
        dh.installPortableNodeWindows((err, detail: InstallDetail = {}) => {
        if (err) return json(res, { ok: false, message: err.message, ...detail }, 400)
        json(res, { ok: true, ...detail, message: detail.message || '便携 Node/npm 已安装' })
      })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handlePostNpmInstall(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  try {
    const dependencies = dh.getProjectDependencyStatus()
    if (dependencies.ready) return json(res, { ok: true, skipped: true, message: '项目依赖已安装', status: dh.getLocalNpmInstallStatus() })
    const npmInfo = getCommandInfo('npm') as LegacyCommandInfo
    const cwd = path.resolve(KOISHI_DIR)
    const npmCmd = npmInfo.found ? npmInfo.path : 'npm'
    const steps = [{ label: '打开终端（PowerShell 或 CMD）并进入项目目录', command: `cd /d "${cwd}"` }, { label: '执行依赖安装', command: npmInfo.found ? `"${npmCmd}" install` : 'npm install' }]
    if (!npmInfo.found) steps.unshift({ label: '先安装 Node.js（包含 npm）', command: '前往 https://nodejs.org 下载安装，或在部署器中安装便携 Node' })
    return json(res, { ok: true, guide: true, message: '请在终端中手动执行以下命令安装依赖', steps, cwd, npmPath: npmCmd, status: dh.getLocalNpmInstallStatus() })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
}

function handlePostNpmRepairAndInstall(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  try {
    const diagnostics = dh.collectNpmInstallDiagnostics(true)
    const proxy = diagnostics.proxy || dh.diagnoseNpmProxy(diagnostics)
    const cwd = path.resolve(KOISHI_DIR)
    const npmInfo = getCommandInfo('npm') as LegacyCommandInfo
    const npmCmd = npmInfo.found ? npmInfo.path : 'npm'
    const hasNpmProxy = !!(diagnostics.config?.proxy || diagnostics.config?.httpsProxy)
    const hasEnvProxy = Object.entries(diagnostics.env || {}).some(([key, value]) => !/^no_proxy$/i.test(key) && !!value)
    const repairCommands = dh.commandListForNpmProxyFix(hasNpmProxy, hasEnvProxy)
    const steps: NpmGuideStep[] = []
    if (repairCommands.length) steps.push({ label: '在终端中执行以下命令清理代理配置', command: repairCommands.join('\n') })
    steps.push({ label: '修复后执行依赖安装', command: npmInfo.found ? `"${npmCmd}" install` : 'npm install' })
    return json(res, { ok: true, guide: true, message: '请在终端中手动执行以下修复和安装命令', steps, cwd, npmPath: npmCmd, proxy, diagnostics, status: dh.getLocalNpmInstallStatus() })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
}

function handleGetNpmInstallStatus(req: IncomingMessage, res: ServerResponse): void { return json(res, { ok: true, status: dh.getLocalNpmInstallStatus() }) }

function handlePostNapcatStart(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  try {
    const current = dh.getLocalNapcatDeployStatus()
    if (current.running) return json(res, { ok: true, message: 'NapCat 看起来已经在运行', status: current })
    const { detected, entry } = dh.getNapcatStartEntry()
    if (!detected.found || !entry) return json(res, { ok: false, message: detected.reason || '未找到可启动的 NapCat，请先安装官方 Windows 包', napcat: detected }, 400)
    const ext = path.extname(entry).toLowerCase()
    const cwd = path.dirname(entry)
    let command: string = entry, args: string[] = []
    if (ext === '.bat' || ext === '.cmd') { command = 'cmd.exe'; args = ['/d', '/c', entry] }
    else if (/^NapCatWinBootMain\.exe$/i.test(path.basename(entry))) {
      const qq = String(dh.readLocalDeployManifest().qq || '').trim()
      if (!/^\d+$/.test(qq)) { const detail = fs.existsSync(LOCAL_DEPLOY_MANIFEST_FILE) ? '本地部署清单中缺少有效 qq 字段或格式错误' : `未找到 ${toProjectRel(LOCAL_DEPLOY_MANIFEST_FILE)}，请先完成本地部署并填写 QQ 号`; return json(res, { ok: false, message: `无法启动 NapCat（NapCatWinBootMain 需要登录 QQ 号）：${detail}`, napcat: detected }, 400) }
      args = [qq]
    }
    else if (ext === '.js' || ext === '.mjs') { command = getLocalToolCommand('node'); args = [entry] }
    const { getLocalTaskOptions } = require('../tools') as typeof import('../tools')
    spawnLocalTask('napcat', command, args, getLocalTaskOptions({ cwd }))
    return json(res, { ok: true, message: 'NapCat 已启动，请等待 WebUI 或控制台二维码出现后扫码登录', status: dh.getLocalNapcatDeployStatus() })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
}

function handleGetNapcatStatus(req: IncomingMessage, res: ServerResponse): void { return json(res, { ok: true, status: dh.getLocalNapcatDeployStatus() }) }

function handlePostKoishiStart(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  try {
    const current = dh.getLocalKoishiDeployStatus()
    if (current.running) return json(res, { ok: true, message: 'Koishi 看起来已经在运行', status: current })
    const dependencies = dh.getProjectDependencyStatus()
    if (!dependencies.ready) return json(res, { ok: false, message: '项目依赖尚未完整安装，请先在终端执行 npm install', dependencies }, 400)
    const { getLocalTaskOptions } = require('../tools') as typeof import('../tools')
    if (process.platform === 'win32' && fs.existsSync(path.join(KOISHI_DIR, 'start-local.bat'))) {
      spawnLocalTask('koishi', 'cmd.exe', ['/d', '/c', path.join(KOISHI_DIR, 'start-local.bat')], getLocalTaskOptions({ cwd: KOISHI_DIR }))
    } else {
      spawnLocalTask('koishi', getLocalToolCommand('node'), ['start.js'], getLocalTaskOptions({ cwd: KOISHI_DIR, shell: process.platform === 'win32', env: { KOISHI_DIR: path.resolve(KOISHI_DIR), DONGXUELIAN_AI_DATA_DIR: DATA_DIR } }))
    }
    return json(res, { ok: true, message: 'Koishi 已启动，正在等待 ' + dh.resolveKoishiListenPort() + ' 端口和 OneBot 连接', status: dh.getLocalKoishiDeployStatus() })
  } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
}

function handleGetKoishiStatus(req: IncomingMessage, res: ServerResponse): void { return json(res, { ok: true, status: dh.getLocalKoishiDeployStatus() }) }

function handleGetLocalReadyCheck(req: IncomingMessage, res: ServerResponse): void {
  try { return json(res, dh.buildLocalReadyCheck()) } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
}

/** Resolve a temporary path-encoding probe dir without touching KOISHI_DIR. */
function getEnvCheckPathEncodingDir() {
  return path.join(os.tmpdir(), 'lianlian-path-encoding-check', '中文路径')
}

function handleGetEnvCheck(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  const localDeployTarget = dh.getLocalDeployTarget()
  const nodeInfo = getCommandInfo('node', 18)
  const npmInfo = getCommandInfo('npm')
  const dependencyStatus = dh.getProjectDependencyStatus()
  const portList = [dh.resolveKoishiListenPort(), Number(PORT), resolveNapcatOnebotListenPort(), resolveNapcatWebuiListenPort()]
  const ports: Record<number, PortState> = {}
  for (const port of portList) ports[port] = checkPortState(port)
  return json(res, { platform: process.platform, host: { platform: process.platform, arch: process.arch, hostname: os.hostname() }, localDeployTarget, blocked: localDeployTarget.blocked, blockedReason: localDeployTarget.blockedReason, projectDir: path.resolve(KOISHI_DIR), runtimeDir: dh.getLocalDeployTarget().runtimeDir, node: nodeInfo, npm: npmInfo, dependencies: dependencyStatus, localConfig: dh.buildLocalConfigPreview(), managedArtifacts: { deleteItems: 0, userDataItems: 0, deleteSize: 0, userDataSize: 0 }, workDir: { exists: fs.existsSync(KOISHI_DIR), path: path.resolve(KOISHI_DIR), writable: null, reason: '环境检测不写入项目目录' }, pathEncoding: dh.inspectChinesePathWrite(getEnvCheckPathEncodingDir()), ports, napcat: detectNapcatInstallation() })
}

function handleGetBotLocalStatus(req: IncomingMessage, res: ServerResponse): void {
  try {
    const target = dh.getLocalDeployTarget()
    if (!target.canRunWindowsLocalDeploy) return json(res, { running: false, workers: 0, blocked: true, localDeployTarget: target, message: target.blockedReason })
    if (process.platform === 'win32') { const port = checkPortState(dh.resolveKoishiListenPort()); return json(res, { running: port.status === 'occupied', workers: port.status === 'occupied' ? 1 : 0, port }) }
    const out = execSync("ps aux | grep 'koishi/lib/worker' | grep -v grep", { encoding: 'utf8', timeout: 3000 }).trim()
    const running = out.split('\n').filter(Boolean).length
    return json(res, { running: running > 0, workers: running })
  } catch { return json(res, { running: false, workers: 0 }) }
}

function handlePostBotLocalStop(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  if (!dh.requireWindowsLocalDeployTarget(req, res)) return
  try { stopKoishiProcesses(); return json(res, { ok: true, message: '本地 Bot 已停止' }) }
  catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }) }
}

const routes = {
  'GET /dashboard/api/deploy/config': handleGetDeployConfig,
  'GET /dashboard/api/deploy/check-update': handleGetCheckUpdate,
  'PUT /dashboard/api/deploy/config': handlePutDeployConfig,
  'POST /dashboard/api/deploy/run': handlePostDeployRun,
  'POST /dashboard/api/deploy/confirm': handlePostDeployConfirm,
  'POST /dashboard/api/deploy/upload': handlePostDeployUpload,
  'POST /dashboard/api/deploy/local': handlePostDeployLocal,
  'GET /dashboard/api/deploy/local-config-preview': handleGetLocalConfigPreview,
  'POST /dashboard/api/deploy/local-config-delete': handlePostLocalConfigDelete,
  'GET /dashboard/api/deploy/local-uninstall-preview': handleGetLocalUninstallPreview,
  'POST /dashboard/api/deploy/local-uninstall': handlePostLocalUninstall,
  'POST /dashboard/api/deploy/napcat-download': handlePostNapcatDownload,
  'POST /dashboard/api/deploy/napcat-windows-download': handlePostNapcatWindowsDownload,
  'POST /dashboard/api/deploy/node-windows-install': handlePostNodeWindowsInstall,
  'POST /dashboard/api/deploy/npm-install': handlePostNpmInstall,
  'POST /dashboard/api/deploy/npm-repair-and-install': handlePostNpmRepairAndInstall,
  'GET /dashboard/api/deploy/npm-install-status': handleGetNpmInstallStatus,
  'POST /dashboard/api/deploy/napcat-start': handlePostNapcatStart,
  'GET /dashboard/api/deploy/napcat-status': handleGetNapcatStatus,
  'POST /dashboard/api/deploy/koishi-start': handlePostKoishiStart,
  'GET /dashboard/api/deploy/koishi-status': handleGetKoishiStatus,
  'GET /dashboard/api/deploy/local-ready-check': handleGetLocalReadyCheck,
  'GET /dashboard/api/env/check': handleGetEnvCheck,
  'POST /dashboard/api/frontend/rebuild': handlePostFrontendRebuild,
  'GET /dashboard/api/frontend/rebuild-status': handleGetFrontendRebuildStatus,
  'GET /dashboard/api/bot/local-status': handleGetBotLocalStatus,
  'POST /dashboard/api/bot/local-stop': handlePostBotLocalStop,
} satisfies Record<string, DeployRouteHandler>

const prefixRoutes: DeployPrefixRoute[] = [
  { prefix: '/dashboard/api/deploy/progress/', method: 'GET', handler: handleGetDeployProgress },
]

export = { routes, prefixRoutes }
