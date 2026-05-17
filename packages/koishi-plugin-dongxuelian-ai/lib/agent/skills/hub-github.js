/**
 * MODULE: Skill Hub GitHub Adapter。
 * 职责: 从 GitHub 仓库下载 Skill 目录到本地临时目录。
 * 边界: 只下载文件、不安装到 Pool。
 * 状态: 无。
 */
const https = require('https')
const path = require('path')
const fsp = require('fs/promises')
const { ensureDir } = require('./store')
const { registerAdapter } = require('./hub')

const GITHUB_API = 'https://api.github.com'
const MAX_FILES = 30
const MAX_FILE_SIZE = 500 * 1024
const REQUEST_TIMEOUT = 15000

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: { 'User-Agent': 'dongxuelian-skill-hub/1.0', Accept: 'application/vnd.github.v3+json', ...headers },
      timeout: REQUEST_TIMEOUT,
    }
    const req = https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, headers).then(resolve, reject)
      }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        if (res.statusCode >= 400) {
          return reject(new Error(`GitHub API ${res.statusCode}: ${body.toString('utf8').slice(0, 200)}`))
        }
        resolve({ status: res.statusCode, body })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
  })
}

async function fetchContentsTree(owner, repo, skillPath, branch) {
  const ref = branch || 'main'
  const apiPath = skillPath ? `${GITHUB_API}/repos/${owner}/${repo}/contents/${skillPath}?ref=${ref}` : `${GITHUB_API}/repos/${owner}/${repo}/contents?ref=${ref}`
  const { body } = await httpsGet(apiPath)
  const items = JSON.parse(body.toString('utf8'))
  if (!Array.isArray(items)) throw new Error('Expected directory listing from GitHub')
  return items
}

async function downloadGitHubSkill({ owner, repo, skillPath, branch, tempDir, url }) {
  if (!owner || !repo) {
    if (url) {
      const parsed = parseGitHubUrl(url)
      if (!parsed) return { ok: false, error: 'Cannot parse GitHub URL' }
      owner = parsed.owner
      repo = parsed.repo
      skillPath = parsed.path || skillPath
      branch = parsed.branch || branch
    } else {
      return { ok: false, error: 'Missing owner/repo' }
    }
  }

  const items = await fetchContentsTree(owner, repo, skillPath, branch)
  const files = items.filter(i => i.type === 'file' && i.size <= MAX_FILE_SIZE).slice(0, MAX_FILES)

  if (!files.length) return { ok: false, error: 'No downloadable files found' }

  await ensureDir(tempDir)
  for (const file of files) {
    const { body } = await httpsGet(file.download_url, {})
    const dest = path.join(tempDir, file.name)
    await fsp.writeFile(dest, body)
  }

  return { ok: true, dir: tempDir }
}

function parseGitHubUrl(url) {
  const match = String(url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/([^/]+)(?:\/(.+))?)?(?:\.git)?$/i)
  if (!match) return null
  return { owner: match[1], repo: match[2], branch: match[3] || 'main', path: match[4] || '' }
}

registerAdapter('github', downloadGitHubSkill)

module.exports = {
  downloadGitHubSkill,
  parseGitHubUrl,
  fetchContentsTree,
}
