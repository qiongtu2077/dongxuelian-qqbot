'use strict'
import type { ExecException } from 'child_process'

const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { exec } = require('child_process') as typeof import('child_process')
const { FE_DIR, DIST_DIR } = require('./paths') as { FE_DIR: string; DIST_DIR: string }

interface FrontendBuildStatus {
  state: string
  message: string
  detail: string
  startedAt: number
  finishedAt: number
}

interface FrontendBuildOptions {
  feDir?: string
  distDir?: string
  backupDir?: string
  log?: (message: string) => void
  updateStatus?: (status: FrontendBuildStatus) => void
}

type FrontendBuildCallback = (err: Error | null) => void

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message || '')
  return String(error || '')
}

function toError(error: unknown, fallback = 'frontend build failed'): Error {
  return error instanceof Error ? error : new Error(getErrorMessage(error) || fallback)
}

function getFrontendDistAssetRefs(distDir = DIST_DIR): string[] {
  const indexFile = path.join(distDir, 'index.html')
  let html = ''
  try { html = fs.readFileSync(indexFile, 'utf8') } catch { return [] }
  const refs = new Set<string>()
  const re = /(?:src|href)=["']\/dashboard\/(assets\/[^"']+)["']/g
  let match
  while ((match = re.exec(html))) refs.add(match[1])
  return [...refs]
}

function hasFrontendDistAssets(distDir = DIST_DIR) {
  const indexFile = path.join(distDir, 'index.html')
  const assetsDir = path.join(distDir, 'assets')
  if (!fs.existsSync(indexFile) || !fs.existsSync(assetsDir)) return false
  const refs = getFrontendDistAssetRefs(distDir)
  if (!refs.length) return false
  if (!refs.every(ref => fs.existsSync(path.join(distDir, String(ref))))) return false
  return refs.some(ref => /\.js$/i.test(ref))
}

function assertFrontendDistReady(distDir = DIST_DIR) {
  if (!hasFrontendDistAssets(distDir)) throw new Error('frontend dist is missing or incomplete; rebuild frontend first')
}

function assertFrontendBuildSourceReady(feDir = FE_DIR) {
  const required = ['package.json', 'index.html', 'vite.config.ts', 'src']
  for (const name of required) {
    if (!fs.existsSync(path.join(feDir, name))) throw new Error('frontend source is missing: ' + path.join(feDir, name))
  }
  if (!fs.existsSync(path.join(feDir, 'node_modules'))) {
    throw new Error('前端依赖未安装，请先在 frontend 目录执行 npm install')
  }
}

function rollbackFrontendDist(distDir: string, backupDir: string): string {
  try { fs.rmSync(distDir, { recursive: true, force: true }) }
  catch (e) { return 'remove incomplete dist failed: ' + getErrorMessage(e) }
  try {
    if (fs.existsSync(backupDir)) fs.renameSync(backupDir, distDir)
  } catch (e) { return 'restore previous dist failed: ' + getErrorMessage(e) }
  return ''
}

function buildFrontendDist(options: FrontendBuildOptions = {}, callback?: FrontendBuildCallback) {
  const feDir = options.feDir || FE_DIR
  const distDir = options.distDir || DIST_DIR
  const backupDir = options.backupDir || path.join(feDir, 'dist.bak')
  const startedAt = Date.now()
  const logFn = typeof options.log === 'function' ? options.log : () => {}
  const updateStatus = typeof options.updateStatus === 'function' ? options.updateStatus : null
  const done: FrontendBuildCallback = typeof callback === 'function' ? callback : () => {}

  try {
    assertFrontendBuildSourceReady(feDir)
    logFn('frontend build source: ' + feDir)
    logFn('frontend build dist: ' + distDir)
    fs.rmSync(backupDir, { recursive: true, force: true })
    if (fs.existsSync(distDir)) fs.renameSync(distDir, backupDir)
  } catch (e) {
    if (updateStatus) updateStatus({ state: 'failed', message: 'frontend build preparation failed', detail: getErrorMessage(e), startedAt, finishedAt: Date.now() })
    done(toError(e, 'frontend build preparation failed'))
    return false
  }

  if (updateStatus) updateStatus({ state: 'building', message: 'building', detail: '', startedAt, finishedAt: 0 })
  logFn('frontend build start: npm run build')
  exec('npm run build', { cwd: feDir, timeout: 120000, maxBuffer: 1024 * 1024 }, (err: ExecException | null, stdout: string, stderr: string) => {
    try {
      if (stdout) logFn(stdout.trim())
      if (stderr) logFn(stderr.trim())
      if (err) {
        const rollbackError = rollbackFrontendDist(distDir, backupDir)
        const detail = [stderr || err.message || '', rollbackError].filter(Boolean).join('\n').slice(-1200)
        if (updateStatus) updateStatus({ state: 'failed', message: 'frontend build failed and rolled back', detail, startedAt, finishedAt: Date.now() })
        done(new Error(detail || 'frontend build failed'))
        return
      }
      if (!hasFrontendDistAssets(distDir)) {
        const rollbackError = rollbackFrontendDist(distDir, backupDir)
        const detail = rollbackError || 'frontend dist is incomplete'
        if (updateStatus) updateStatus({ state: 'failed', message: 'frontend dist is incomplete and rolled back', detail, startedAt, finishedAt: Date.now() })
        done(new Error(detail))
        return
      }
      fs.rmSync(backupDir, { recursive: true, force: true })
      if (updateStatus) updateStatus({ state: 'success', message: 'frontend build success', detail: '', startedAt, finishedAt: Date.now() })
      logFn('frontend build success')
      done(null)
    } catch (e) {
      if (updateStatus) updateStatus({ state: 'failed', message: 'frontend rebuild cleanup failed', detail: getErrorMessage(e), startedAt, finishedAt: Date.now() })
      done(toError(e, 'frontend rebuild cleanup failed'))
    }
  })
  return true
}

export = {
  getFrontendDistAssetRefs,
  hasFrontendDistAssets,
  assertFrontendDistReady,
  assertFrontendBuildSourceReady,
  rollbackFrontendDist,
  buildFrontendDist,
}
